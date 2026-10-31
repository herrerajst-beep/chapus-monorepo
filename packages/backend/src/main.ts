import http from 'http';
import { randomBytes, randomInt } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { Server as SocketServer } from 'socket.io';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';

import { verifyAndProvisionPostGIS } from './database/provision-postgis';
import { createHealthHandler } from './modules/health/health.controller';
import {
  ServiceRequestSerializer,
  ServiceRequestRow,
} from './modules/bookings/serializers/service-request.serializer';
import { deriveApproximateZone } from './modules/bookings/utils/derive-zone';
import { JobStateBroadcaster } from './modules/realtime/job-state-broadcaster';
import { GeoDispatcherService } from './modules/dispatch/geo-dispatcher.service';

// 1. VALIDACIÓN ESTRICTA DE SECRETOS (Fail-Fast)
// Función en vez de `if` suelto: el estrechamiento a `string` debe sobrevivir dentro de los closures.
function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim().length < 16) {
    console.error(
      '[FATAL] Variable de entorno JWT_SECRET ausente o insegura (<16 chars). Abortando arranque.'
    );
    process.exit(1);
  }
  return secret;
}

const JWT_SECRET = requireJwtSecret();

const PORT = Number(process.env.PORT || 4000);

// Bandera estricta de entorno: solo permite atajos de auditoría fuera de producción
const IS_STAGING_OR_DEV =
  process.env.NODE_ENV === 'staging' || process.env.NODE_ENV === 'development';

interface JwtClaims {
  sub: string;
  role: 'CLIENT' | 'PROVIDER' | 'DUAL';
  kycStatus: 'UNVERIFIED' | 'PENDING_VERIFICATION' | 'VERIFIED' | 'RESTRICTED';
  stripeAccountId: string | null;
}

const SELECT_REQUEST_COLUMNS = `
  sr.id,
  sr.client_id,
  sr.assigned_provider_id,
  sr.category_id,
  sr.pricing_model,
  sr.offered_price,
  sr.final_agreed_price,
  ST_Y(sr.location::geometry) AS lat,
  ST_X(sr.location::geometry) AS lng,
  sr.address_text,
  sr.approximate_zone,
  sr.description,
  sr.photo_urls,
  sr.status,
  sr.version,
  sr.scheduled_at,
  sr.created_at,
  sr.accepted_at,
  sr.completed_at,
  (SELECT COUNT(*)::int FROM bids b WHERE b.request_id = sr.id AND b.status = 'PENDING') AS bids_count
`;

async function seedDefaultCategories(db: Pool) {
  await db.query(`
    INSERT INTO service_categories (id, name, slug, allowed_models, base_fixed_price_eur, platform_fee_percent)
    VALUES
      (101, 'Fontanería de Urgencia', 'fontaneria-urgente', '{FAST_MATCH,BIDDING}', 65.00, 15.00),
      (102, 'Limpieza Exprés a Domicilio', 'limpieza-expres', '{FAST_MATCH,BIDDING}', 55.00, 15.00),
      (103, 'Electricidad y Averías', 'electricidad-averias', '{FAST_MATCH,BIDDING}', 70.00, 15.00)
    ON CONFLICT (slug) DO NOTHING;
  `);
}

async function bootstrap() {
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.NODE_ENV === 'staging' || process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    max: 20,
  });

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
  });

  await verifyAndProvisionPostGIS(db);
  await seedDefaultCategories(db);

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const httpServer = http.createServer(app);
  const io = new SocketServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PATCH'] },
    transports: ['websocket', 'polling'],
  });

  const logger = {
    info: (obj: object, msg: string) =>
      console.log(JSON.stringify({ level: 'INFO', msg, ...obj, ts: new Date().toISOString() })),
    warn: (obj: object, msg: string) =>
      console.warn(JSON.stringify({ level: 'WARN', msg, ...obj, ts: new Date().toISOString() })),
    error: (obj: object, msg: string) =>
      console.error(JSON.stringify({ level: 'ERROR', msg, ...obj, ts: new Date().toISOString() })),
  };

  const broadcaster = new JobStateBroadcaster(io);
  const fcmStub: any = {
    sendEachForMulticast: async () => ({ successCount: 0, failureCount: 0 }),
  };
  const dispatcher = new GeoDispatcherService(io, fcmStub, logger);

  // ==========================================
  // NAMESPACES SOCKET.IO v4 (/offers y /bookings)
  // ==========================================
  const offersNsp = io.of('/offers');
  offersNsp.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) {
        return next(
          Object.assign(new Error('UNAUTHORIZED'), {
            data: { statusCode: 401, errorCode: 'UNAUTHORIZED' },
          })
        );
      }

      const payload = jwt.verify(token, JWT_SECRET) as JwtClaims;
      if (payload.kycStatus !== 'VERIFIED') {
        return next(
          Object.assign(new Error('Forbidden: KYC verification required'), {
            data: {
              statusCode: 403,
              errorCode: 'KYC_VERIFICATION_REQUIRED',
              kycStatus: payload.kycStatus,
            },
          })
        );
      }
      socket.data.user = payload;
      return next();
    } catch {
      return next(
        Object.assign(new Error('INVALID_TOKEN'), {
          data: { statusCode: 401, errorCode: 'INVALID_TOKEN' },
        })
      );
    }
  });

  offersNsp.on('connection', (socket) => {
    const providerId = socket.data.user.sub;
    socket.join(`provider:${providerId}`);
    logger.info({ providerId, socketId: socket.id }, '[WS /offers] Proveedor conectado a sala');
  });

  const bookingsNsp = io.of('/bookings');
  bookingsNsp.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) return next(new Error('UNAUTHORIZED'));
      socket.data.user = jwt.verify(token, JWT_SECRET) as JwtClaims;
      return next();
    } catch {
      return next(new Error('UNAUTHORIZED'));
    }
  });

  bookingsNsp.on('connection', (socket) => {
    const userId = socket.data.user.sub;
    socket.join(`client:${userId}`);

    socket.on(
      'request:subscribe',
      async (requestId: string, cb?: (res: { ok: boolean; error?: string }) => void) => {
        try {
          const { rows } = await db.query(
            `SELECT client_id, assigned_provider_id, status FROM service_requests WHERE id = $1`,
            [requestId]
          );
          if (rows.length === 0) return cb?.({ ok: false, error: 'NOT_FOUND' });

          const r = rows[0];
          const allowed =
            r.client_id === userId ||
            (r.assigned_provider_id === userId &&
              ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED'].includes(r.status));

          if (!allowed) return cb?.({ ok: false, error: 'RGPD_FORBIDDEN_CHANNEL' });

          await socket.join(`request:${requestId}`);
          return cb?.({ ok: true });
        } catch {
          return cb?.({ ok: false, error: 'INTERNAL_ERROR' });
        }
      }
    );
  });

  // ==========================================
  // MIDDLEWARE DE AUTENTICACIÓN REST
  // ==========================================
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
        message: 'Token Bearer requerido.',
        timestamp: new Date().toISOString(),
      });
    }
    try {
      (req as any).user = jwt.verify(header.slice(7), JWT_SECRET) as JwtClaims;
      return next();
    } catch {
      return res.status(401).json({
        statusCode: 401,
        errorCode: 'INVALID_TOKEN',
        message: 'Token expirado o inválido.',
        timestamp: new Date().toISOString(),
      });
    }
  };

  const v1 = express.Router();

  // 1. HEALTHCHECK
  v1.get('/health', createHealthHandler(db, redis));

  // 2. AUTENTICACIÓN PASSWORDLESS (OTP) + SESIÓN + REFRESH
  const handleOtpSend = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { phone } = req.body || {};
      if (!phone || typeof phone !== 'string') {
        return res.status(400).json({
          statusCode: 400,
          errorCode: 'INVALID_PHONE',
          message: 'El teléfono es obligatorio.',
          timestamp: new Date().toISOString(),
        });
      }
      // En producción: 6 dígitos criptográficos aleatorios.
      // En staging/dev: permite variable STAGE_FIXED_OTP o '123456' para pruebas E2E.
      const otpCode = IS_STAGING_OR_DEV
        ? process.env.STAGE_FIXED_OTP || '123456'
        : String(randomInt(100000, 1000000));
      await redis.set(`otp:${phone}`, otpCode, 'EX', 300);

      logger.info({ phone, env: process.env.NODE_ENV }, '[Auth] OTP generado y almacenado en Redis');
      return res.status(200).json({
        retryAfterSeconds: 60,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    } catch (err) {
      return next(err);
    }
  };

  v1.post('/auth/otp/send', handleOtpSend);
  v1.post('/auth/otp/request', handleOtpSend); // Alias de compatibilidad

  v1.post('/auth/otp/verify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { phone, code, requestedRole = 'CLIENT', fcmToken = null } = req.body || {};
      if (!phone || !code) {
        return res.status(400).json({
          statusCode: 400,
          errorCode: 'MISSING_FIELDS',
          message: 'Teléfono y código OTP requeridos.',
          timestamp: new Date().toISOString(),
        });
      }

      const storedOtp = await redis.get(`otp:${phone}`);

      // BLOQUEO DE SEGURIDAD: El bypass '123456' SOLO se evalúa si IS_STAGING_OR_DEV es true
      const isValidOtp =
        (storedOtp !== null && storedOtp === code) || (IS_STAGING_OR_DEV && code === '123456');

      if (!isValidOtp) {
        return res.status(401).json({
          statusCode: 401,
          errorCode: 'INVALID_OTP',
          message: 'Código OTP inválido o expirado.',
          timestamp: new Date().toISOString(),
        });
      }
      await redis.del(`otp:${phone}`);

      // En PRODUCCIÓN todo usuario nuevo nace siempre como 'UNVERIFIED'.
      // Solo en STAGING/DEV se auto-verifica para la prueba de latencia (salvo sufijo '0000').
      const initialKycStatus = IS_STAGING_OR_DEV
        ? phone.endsWith('0000')
          ? 'PENDING_VERIFICATION'
          : 'VERIFIED'
        : 'UNVERIFIED';

      const upsertRes = await db.query(
        `INSERT INTO users (phone, full_name, role, kyc_status, fcm_token, is_online)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (phone) DO UPDATE
           SET role = EXCLUDED.role,
               fcm_token = COALESCE(EXCLUDED.fcm_token, users.fcm_token),
               updated_at = NOW()
         RETURNING
           id, email, phone, full_name AS "fullName", role AS "activeRole",
           kyc_status AS "kycStatus", stripe_account_id AS "stripeAccountId",
           is_online AS "isOnline", service_radius_km::float AS "serviceRadiusKm",
           rating_avg::float AS "ratingAvg"`,
        [phone, `Usuario ${phone.slice(-4)}`, requestedRole, initialKycStatus, fcmToken]
      );

      const user = upsertRes.rows[0];
      // Auto-suscripción a categorías solo en Staging/Dev para agilizar la prueba de radio
      if (IS_STAGING_OR_DEV && (user.activeRole === 'PROVIDER' || user.activeRole === 'DUAL')) {
        await db.query(
          `INSERT INTO provider_services (provider_id, category_id)
           SELECT $1, id FROM service_categories
           ON CONFLICT DO NOTHING`,
          [user.id]
        );
      }

      const expiresIn = 86400;
      const accessToken = jwt.sign(
        {
          sub: user.id,
          role: user.activeRole,
          kycStatus: user.kycStatus,
          stripeAccountId: user.stripeAccountId,
        } satisfies JwtClaims,
        JWT_SECRET,
        { expiresIn }
      );

      const refreshToken = `rt_chapus_${randomBytes(32).toString('hex')}`;
      await redis.set(`refresh_token:${refreshToken}`, user.id, 'EX', 60 * 60 * 24 * 30);

      return res.status(200).json({
        accessToken,
        refreshToken,
        expiresIn,
        user,
      });
    } catch (err) {
      return next(err);
    }
  });

  v1.post('/auth/refresh', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body || {};
      if (!refreshToken) {
        return res.status(401).json({
          statusCode: 401,
          errorCode: 'MISSING_REFRESH_TOKEN',
          message: 'Refresh token requerido.',
          timestamp: new Date().toISOString(),
        });
      }

      const tokenKey = `refresh_token:${refreshToken}`;
      const userId = await redis.get(tokenKey);
      if (!userId) {
        return res.status(401).json({
          statusCode: 401,
          errorCode: 'INVALID_REFRESH_TOKEN',
          message: 'Refresh token inválido o expirado.',
          timestamp: new Date().toISOString(),
        });
      }

      await redis.del(tokenKey);

      const { rows } = await db.query(
        `SELECT id, email, phone, full_name AS "fullName", role AS "activeRole",
                kyc_status AS "kycStatus", stripe_account_id AS "stripeAccountId",
                is_online AS "isOnline", service_radius_km::float AS "serviceRadiusKm",
                rating_avg::float AS "ratingAvg"
         FROM users WHERE id = $1`,
        [userId]
      );

      if (rows.length === 0) {
        return res.status(401).json({
          statusCode: 401,
          errorCode: 'USER_NOT_FOUND',
          message: 'Usuario no encontrado.',
          timestamp: new Date().toISOString(),
        });
      }

      const user = rows[0];
      const expiresIn = 86400;
      const accessToken = jwt.sign(
        {
          sub: user.id,
          role: user.activeRole,
          kycStatus: user.kycStatus,
          stripeAccountId: user.stripeAccountId,
        } satisfies JwtClaims,
        JWT_SECRET,
        { expiresIn }
      );

      const newRefreshToken = `rt_chapus_${randomBytes(32).toString('hex')}`;
      await redis.set(`refresh_token:${newRefreshToken}`, user.id, 'EX', 60 * 60 * 24 * 30);

      return res.status(200).json({
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn,
        user,
      });
    } catch (err) {
      return next(err);
    }
  });

  v1.get('/auth/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const { rows } = await db.query(
        `SELECT id, email, phone, full_name AS "fullName", role AS "activeRole",
                kyc_status AS "kycStatus", stripe_account_id AS "stripeAccountId",
                is_online AS "isOnline", service_radius_km::float AS "serviceRadiusKm",
                rating_avg::float AS "ratingAvg"
         FROM users WHERE id = $1`,
        [userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({
          statusCode: 404,
          errorCode: 'USER_NOT_FOUND',
          message: 'Perfil no encontrado.',
          timestamp: new Date().toISOString(),
        });
      }
      return res.status(200).json(rows[0]);
    } catch (err) {
      return next(err);
    }
  });

  // 3. CATÁLOGO
  v1.get('/catalog/categories', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query(`
        SELECT
          id,
          slug,
          name,
          allowed_models AS "allowedModels",
          base_fixed_price_eur::float AS "baseFixedPriceEur",
          platform_fee_percent::float AS "platformFeePercent"
        FROM service_categories
        ORDER BY id ASC
      `);
      return res.status(200).json(rows);
    } catch (err) {
      return next(err);
    }
  });

  // 4. GEOLOCALIZACIÓN (HEARTBEAT POSTGIS + RADAR CERCANO)
  v1.patch(
    '/geo/provider-heartbeat',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = (req as any).user.sub;
        const { location, isOnline = true, fcmToken = null } = req.body || {};

        if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
          return res.status(400).json({
            statusCode: 400,
            errorCode: 'INVALID_LOCATION',
            message: 'Coordenadas lat/lng numéricas requeridas.',
            timestamp: new Date().toISOString(),
          });
        }

        await db.query(
          `UPDATE users
           SET last_location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
               is_online = $3,
               fcm_token = COALESCE($4, fcm_token),
               updated_at = NOW()
           WHERE id = $5`,
          [location.lng, location.lat, Boolean(isOnline), fcmToken, userId]
        );

        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    }
  );

  v1.get(
    '/geo/nearby-requests',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const viewerUserId = (req as any).user.sub;
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const radiusKm = Number(req.query.radiusKm || 15);

        if (Number.isNaN(lat) || Number.isNaN(lng)) {
          return res.status(400).json({
            statusCode: 400,
            errorCode: 'INVALID_COORDINATES',
            message: 'Query params lat y lng son obligatorios.',
            timestamp: new Date().toISOString(),
          });
        }

        const { rows } = await db.query(
          `SELECT
             ${SELECT_REQUEST_COLUMNS},
             ROUND((ST_Distance(sr.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) / 1000)::numeric, 2)::float AS distance_km
           FROM service_requests sr
           WHERE sr.status = 'OPEN'
             AND ST_DWithin(
               sr.location,
               ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
               $3
             )
           ORDER BY distance_km ASC
           LIMIT 50`,
          [lng, lat, radiusKm * 1000]
        );

        const sanitizedList = rows.map((row: ServiceRequestRow) =>
          ServiceRequestSerializer.toDTO(row, viewerUserId)
        );

        return res.status(200).json(sanitizedList);
      } catch (err) {
        return next(err);
      }
    }
  );

  // 5. SOLICITUDES Y DISPATCHER GEOESPACIAL (DISPARA geo:job_alert Y MIDE ackDeltaMs)
  v1.post('/requests', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientUserId = (req as any).user.sub;
      const {
        categoryId,
        pricingModel,
        offeredPriceEur = null,
        location,
        addressText,
        approximateZone,
        description,
        photoUrls = [],
        scheduledAt = null,
      } = req.body || {};

      if (!categoryId || !pricingModel || !location || !addressText || !description) {
        return res.status(400).json({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'Faltan campos obligatorios para crear la solicitud.',
          timestamp: new Date().toISOString(),
        });
      }

      const safeZone = deriveApproximateZone(
        approximateZone,
        addressText,
        Number(location.lat),
        Number(location.lng)
      );

      const insertRes = await db.query(
        `INSERT INTO service_requests (
           client_id, category_id, pricing_model, offered_price,
           location, address_text, approximate_zone, description, photo_urls, scheduled_at
         )
         VALUES (
           $1, $2, $3, $4,
           ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
           $7, $8, $9, $10, $11
         )
         RETURNING
           id, client_id, assigned_provider_id, category_id, pricing_model,
           offered_price, final_agreed_price,
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
           address_text, approximate_zone, description, photo_urls,
           status, version, scheduled_at, created_at, accepted_at, completed_at,
           0 AS bids_count`,
        [
          clientUserId,
          Number(categoryId),
          pricingModel,
          offeredPriceEur,
          Number(location.lng),
          Number(location.lat),
          addressText,
          safeZone,
          description,
          Array.isArray(photoUrls) ? photoUrls : [],
          scheduledAt,
        ]
      );

      const createdRow: ServiceRequestRow = insertRes.rows[0];

      // Buscar proveedores online y verificados en un radio de 25 km (o conectados al WS en staging)
      const candidatesRes = await db.query(
        `SELECT
           u.id AS "providerId",
           u.fcm_token AS "fcmToken",
           COALESCE(
             ROUND((ST_Distance(u.last_location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) / 1000)::numeric, 2)::float,
             1.2
           ) AS "distanceKm"
         FROM users u
         WHERE u.role IN ('PROVIDER', 'DUAL')
           AND u.is_online = TRUE
           AND u.kyc_status = 'VERIFIED'
           AND u.id <> $3
           AND (
             u.last_location IS NULL
             OR ST_DWithin(
               u.last_location,
               ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
               u.service_radius_km * 1000
             )
           )
         LIMIT 25`,
        [Number(location.lng), Number(location.lat), clientUserId]
      );

      // Guardar candidatos en Redis para poder emitir geo:job_taken cuando uno acepte
      if (candidatesRes.rows.length > 0) {
        await redis.sadd(
          `notified_providers:${createdRow.id}`,
          ...candidatesRes.rows.map((c: any) => c.providerId)
        );
        await redis.expire(`notified_providers:${createdRow.id}`, 3600);
      }

      // Disparar alerta geoespacial asíncrona (emite geo:job_alert y registra ackDeltaMs en logs)
      dispatcher
        .dispatchJobOffer(createdRow, candidatesRes.rows, 1)
        .catch((err) => logger.error({ err: err?.message, requestId: createdRow.id }, '[Dispatcher Error]'));

      const dto = ServiceRequestSerializer.toDTO(createdRow, clientUserId);

      return res.status(201).json({
        request: dto,
        paymentSheet:
          pricingModel === 'FAST_MATCH'
            ? {
                paymentIntentClientSecret: `pi_staging_${createdRow.id}_secret_demo`,
                ephemeralKey: `ek_staging_${createdRow.id}`,
                customerId: `cus_staging_${clientUserId.slice(0, 8)}`,
                publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_chapus_staging',
                amountEur: Number(offeredPriceEur || 65.0),
                currency: 'eur',
              }
            : null,
      });
    } catch (err) {
      return next(err);
    }
  });

  v1.get('/requests/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const viewerUserId = (req as any).user.sub;
      const { rows } = await db.query(
        `SELECT ${SELECT_REQUEST_COLUMNS} FROM service_requests sr WHERE sr.id = $1`,
        [req.params.id]
      );
      if (rows.length === 0) {
        return res.status(404).json({
          statusCode: 404,
          errorCode: 'NOT_FOUND',
          message: 'Solicitud no encontrada.',
          timestamp: new Date().toISOString(),
        });
      }

      const dto = ServiceRequestSerializer.toDTO(rows[0], viewerUserId);
      return res.status(200).json(dto);
    } catch (err) {
      return next(err);
    }
  });

  // 6. PRESUPUESTOS (BIDDING)
  v1.get(
    '/requests/:id/bids',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const viewerUserId = (req as any).user.sub;
        const reqCheck = await db.query(
          `SELECT client_id FROM service_requests WHERE id = $1`,
          [req.params.id]
        );
        if (reqCheck.rowCount === 0) {
          return res.status(404).json({
            statusCode: 404,
            errorCode: 'NOT_FOUND',
            message: 'Solicitud no encontrada.',
            timestamp: new Date().toISOString(),
          });
        }
        if (reqCheck.rows[0].client_id !== viewerUserId) {
          return res.status(403).json({
            statusCode: 403,
            errorCode: 'FORBIDDEN_BIDS_LIST',
            message: 'Solo el creador de la solicitud puede consultar todas las ofertas.',
            timestamp: new Date().toISOString(),
          });
        }

        const { rows } = await db.query(
          `SELECT
             b.id,
             b.request_id AS "requestId",
             b.provider_id AS "providerId",
             json_build_object(
               'id', u.id,
               'fullName', u.full_name,
               'ratingAvg', u.rating_avg::float,
               'completedJobsCount', u.completed_jobs_count,
               'avatarUrl', u.avatar_url
             ) AS "provider",
             b.amount::float AS "amountEur",
             b.estimated_arrival_minutes AS "estimatedArrivalMinutes",
             b.notes,
             b.status,
             b.created_at AS "createdAt"
           FROM bids b
           JOIN users u ON u.id = b.provider_id
           WHERE b.request_id = $1
           ORDER BY b.created_at DESC`,
          [req.params.id]
        );
        return res.status(200).json(rows);
      } catch (err) {
        return next(err);
      }
    }
  );

  v1.post(
    '/requests/:id/bids',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = (req as any).user as JwtClaims;
        if (user.kycStatus !== 'VERIFIED') {
          return res.status(403).json({
            statusCode: 403,
            errorCode: 'KYC_VERIFICATION_REQUIRED',
            message: 'Debes completar tu verificación KYC antes de enviar presupuestos.',
            timestamp: new Date().toISOString(),
          });
        }

        const { amountEur, estimatedArrivalMinutes, notes = '' } = req.body || {};
        const insertBid = await db.query(
          `INSERT INTO bids (request_id, provider_id, amount, estimated_arrival_minutes, notes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (request_id, provider_id) DO UPDATE
             SET amount = EXCLUDED.amount,
                 estimated_arrival_minutes = EXCLUDED.estimated_arrival_minutes,
                 notes = EXCLUDED.notes
           RETURNING id, request_id AS "requestId", provider_id AS "providerId",
                     amount::float AS "amountEur",
                     estimated_arrival_minutes AS "estimatedArrivalMinutes",
                     notes, status, created_at AS "createdAt"`,
          [req.params.id, user.sub, Number(amountEur), Number(estimatedArrivalMinutes), notes]
        );

        const provRes = await db.query(
          `SELECT id, full_name AS "fullName", rating_avg::float AS "ratingAvg",
                  completed_jobs_count AS "completedJobsCount", avatar_url AS "avatarUrl"
           FROM users WHERE id = $1`,
          [user.sub]
        );

        const bidResponse = {
          ...insertBid.rows[0],
          provider: provRes.rows[0],
        };

        io.of('/bookings').to(`request:${req.params.id}`).emit('request:bid_created', {
          requestId: req.params.id,
          bid: bidResponse,
        });

        return res.status(201).json(bidResponse);
      } catch (err) {
        return next(err);
      }
    }
  );

  // 7. ACEPTACIÓN ATÓMICA FAST-MATCH (CON TRY/CATCH Y LIBERACIÓN DE LOCK EN CASO DE FALLO DB)
  v1.post(
    '/requests/:id/fast-accept',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      const user = (req as any).user as JwtClaims;
      const requestId = req.params.id;
      const lockKey = `lock:fast_accept:${requestId}`;

      if (user.kycStatus !== 'VERIFIED') {
        return res.status(403).json({
          statusCode: 403,
          errorCode: 'KYC_VERIFICATION_REQUIRED',
          message: 'Debes verificar tu identidad antes de aceptar servicios.',
          timestamp: new Date().toISOString(),
        });
      }

      let lockAcquired = false;
      try {
        const lockResult = await redis.set(lockKey, user.sub, 'PX', 3000, 'NX');
        if (!lockResult) {
          return res.status(409).json({
            statusCode: 409,
            errorCode: 'JOB_ALREADY_TAKEN',
            message: 'Otro profesional ha aceptado este servicio milisegundos antes.',
            timestamp: new Date().toISOString(),
          });
        }
        lockAcquired = true;

        const updateRes = await db.query(
          `UPDATE service_requests sr
           SET status = 'ASSIGNED',
               assigned_provider_id = $1,
               final_agreed_price = offered_price,
               accepted_at = NOW(),
               version = version + 1
           WHERE sr.id = $2
             AND sr.status = 'OPEN'
             AND sr.pricing_model = 'FAST_MATCH'
           RETURNING ${SELECT_REQUEST_COLUMNS}`,
          [user.sub, requestId]
        );

        if (updateRes.rowCount === 0) {
          await redis.del(lockKey);
          return res.status(409).json({
            statusCode: 409,
            errorCode: 'JOB_ALREADY_TAKEN',
            message: 'El trabajo ya no se encuentra disponible.',
            timestamp: new Date().toISOString(),
          });
        }

        const row: ServiceRequestRow = updateRes.rows[0];

        // Emitir job:updated a Cliente y Proveedor con sus vistas RGPD correspondientes
        broadcaster.emitJobStateTransition(row, 'OPEN');

        // Emitir geo:job_taken a los demás proveedores que recibieron la alerta
        const notifiedProviders = await redis.smembers(`notified_providers:${requestId}`);
        const losingRooms = notifiedProviders
          .filter((id) => id !== user.sub)
          .map((id) => `provider:${id}`);

        if (losingRooms.length > 0) {
          io.of('/offers').to(losingRooms).emit('geo:job_taken', {
            requestId,
            takenAt: new Date().toISOString(),
          });
        }

        return res.status(200).json(ServiceRequestSerializer.toDTO(row, user.sub));
      } catch (err) {
        if (lockAcquired) {
          await redis.del(lockKey).catch(() => {});
        }
        return next(err);
      }
    }
  );

  app.use('/v1', v1);

  // Manejador global de errores (incluyendo excepciones 403 del Serializador RGPD)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    const errorCode = err?.errorCode || (statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'ERROR');
    logger.error({ statusCode, errorCode, message: err?.message }, '[HTTP Error Handler]');

    return res.status(statusCode).json({
      statusCode,
      errorCode,
      message: err?.message || 'Error interno del servidor.',
      timestamp: new Date().toISOString(),
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV }, '[Chapus Backend] Servidor listo');
  });
}

bootstrap().catch((err) => {
  console.error('[Fatal Bootstrap Error]', err);
  process.exit(1);
});
