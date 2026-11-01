import http from 'http';
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Pool, PoolClient } from 'pg';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { verifyAndProvisionPostGIS } from './database/provision-postgis';
import { createHealthHandler } from './modules/health/health.controller';
import {
  ServiceRequestSerializer,
  ServiceRequestRow,
  BookingStatus,
} from './modules/bookings/serializers/service-request.serializer';
import { deriveApproximateZone } from './modules/bookings/utils/derive-zone';
import { JobStateBroadcaster } from './modules/realtime/job-state-broadcaster';
import { GeoDispatcherService } from './modules/dispatch/geo-dispatcher.service';

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim().length < 16) {
    console.error('[FATAL] JWT_SECRET ausente o inseguro (<16 chars).');
    process.exit(1);
  }
  return secret;
}

const JWT_SECRET = requireJwtSecret();
const PORT = Number(process.env.PORT || 4000);
const IS_STAGING_OR_DEV =
  process.env.NODE_ENV === 'staging' || process.env.NODE_ENV === 'development';

const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const hasRealStripe =
  (stripeSecret.startsWith('sk_test_') || stripeSecret.startsWith('sk_live_')) &&
  !stripeSecret.includes('placeholder');

const stripe = hasRealStripe
  ? new Stripe(stripeSecret, { apiVersion: '2024-06-20' as any })
  : null;

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

function initializeFcmMessaging(logger: { info: Function; warn: Function }): admin.messaging.Messaging {
  const rawCreds = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawCreds && rawCreds.trim().length > 20) {
    try {
      const parsed = rawCreds.trim().startsWith('{')
        ? JSON.parse(rawCreds)
        : JSON.parse(Buffer.from(rawCreds, 'base64').toString('utf8'));

      if (admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(parsed) });
      }
      logger.info({ projectId: parsed.project_id }, '[FCM] Firebase Admin activo (REAL)');
      return admin.messaging();
    } catch (err: any) {
      logger.warn({ err: err?.message }, '[FCM] Fallo al parsear FIREBASE_SERVICE_ACCOUNT_JSON; usando stub');
    }
  } else {
    logger.warn({}, '[FCM] FIREBASE_SERVICE_ACCOUNT_JSON ausente; usando stub');
  }

  return {
    sendEachForMulticast: async (payload: any) => {
      logger.warn({ tokensCount: payload?.tokens?.length || 0 }, '[FCM Stub] Push simulado');
      return { successCount: 0, failureCount: 0, responses: [] };
    },
  } as unknown as admin.messaging.Messaging;
}

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

async function createPaymentSheetPayload(
  dbOrClient: Pool | PoolClient,
  userId: string,
  requestId: string,
  amountEur: number
) {
  if (!stripe) {
    if (!IS_STAGING_OR_DEV) {
      const err: any = new Error('Pasarela de pago no configurada en producción.');
      err.statusCode = 503;
      err.errorCode = 'PAYMENT_GATEWAY_UNAVAILABLE';
      throw err;
    }
    return {
      paymentIntentClientSecret: `pi_staging_${requestId}_secret_demo`,
      ephemeralKey: `ek_staging_${requestId}`,
      customerId: `cus_staging_${userId.slice(0, 8)}`,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_chapus_staging',
      amountEur,
      currency: 'eur' as const,
    };
  }

  const amountCents = Math.round(amountEur * 100);
  const userRes = await dbOrClient.query(
    `SELECT email, phone, full_name, stripe_customer_id FROM users WHERE id = $1`,
    [userId]
  );
  let customerId: string | null = userRes.rows[0]?.stripe_customer_id || null;

  if (!customerId) {
    const customer = await stripe.customers.create({
      phone: userRes.rows[0]?.phone,
      name: userRes.rows[0]?.full_name,
      metadata: { chapusUserId: userId },
    });
    customerId = customer.id;
    await dbOrClient.query(`UPDATE users SET stripe_customer_id = $1 WHERE id = $2`, [
      customerId,
      userId,
    ]);
  }

  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: '2024-06-20' }
  );

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: 'eur',
      customer: customerId,
      capture_method: 'manual',
      automatic_payment_methods: { enabled: true },
      transfer_group: `CHAPUS_REQ_${requestId}`,
      metadata: { requestId, clientId: userId },
    },
    { idempotencyKey: `pi_manual_${requestId}_${amountCents}` }
  );

  const feeEur = Number((amountEur * 0.15).toFixed(2));
  const netEur = Number((amountEur - feeEur).toFixed(2));

  await dbOrClient.query(
    `INSERT INTO payments (
       request_id, client_id, stripe_payment_intent_id,
       total_amount, platform_fee, provider_payout, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'REQUIRES_CAPTURE')
     ON CONFLICT (request_id) DO UPDATE
       SET stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
           total_amount = EXCLUDED.total_amount,
           platform_fee = EXCLUDED.platform_fee,
           provider_payout = EXCLUDED.provider_payout`,
    [requestId, userId, paymentIntent.id, amountEur, feeEur, netEur]
  );

  return {
    paymentIntentClientSecret: paymentIntent.client_secret!,
    ephemeralKey: ephemeralKey.secret!,
    customerId,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!,
    amountEur,
    currency: 'eur' as const,
  };
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

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const redisPub = redis.duplicate();
  const redisSub = redis.duplicate();

  const logger = {
    info: (obj: object, msg: string) =>
      console.log(JSON.stringify({ level: 'INFO', msg, ...obj, ts: new Date().toISOString() })),
    warn: (obj: object, msg: string) =>
      console.warn(JSON.stringify({ level: 'WARN', msg, ...obj, ts: new Date().toISOString() })),
    error: (obj: object, msg: string) =>
      console.error(JSON.stringify({ level: 'ERROR', msg, ...obj, ts: new Date().toISOString() })),
  };

  await verifyAndProvisionPostGIS(db);
  await seedDefaultCategories(db);

  const app = express();
  // FALLO 1.6 CORREGIDO: Confiar en el proxy inverso de Render para HTTPS en /uploads/presign y rate-limiting
  app.set('trust proxy', 1);

  const httpServer = http.createServer(app);
  const io = new SocketServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'PUT'] },
    transports: ['websocket', 'polling'],
    adapter: createAdapter(redisPub, redisSub),
  });

  const broadcaster = new JobStateBroadcaster(io);
  const fcmMessaging = initializeFcmMessaging(logger);
  const dispatcher = new GeoDispatcherService(io, fcmMessaging, logger);

  async function findCandidatesAndDispatch(row: ServiceRequestRow) {
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
      [Number(row.lng), Number(row.lat), row.client_id]
    );

    if (candidatesRes.rows.length > 0) {
      await redis.sadd(
        `notified_providers:${row.id}`,
        ...candidatesRes.rows.map((c: any) => c.providerId)
      );
      await redis.expire(`notified_providers:${row.id}`, 3600);
    }

    await dispatcher.dispatchJobOffer(row, candidatesRes.rows, 1);
  }

  // DECISIÓN 2.3: Se elimina el alias legacy `request` y se envía únicamente `job`
  function emitBookingAssignedToProvider(row: ServiceRequestRow, escrowStatus: string = 'ESCROW_HELD') {
    if (!row.assigned_provider_id) return;
    const unmaskedProviderDto = ServiceRequestSerializer.toDTO(row, row.assigned_provider_id);
    const grossPrice = Number(row.final_agreed_price || row.offered_price || 0);
    const guaranteedPayoutEur = Number((grossPrice * 0.85).toFixed(2));

    io.of('/offers')
      .to(`provider:${row.assigned_provider_id}`)
      .emit('booking:assigned', {
        job: unmaskedProviderDto,
        escrowStatus,
        guaranteedPayoutEur,
        assignedAt: new Date().toISOString(),
      });
  }

  // FALLO 1.1 CORREGIDO: El webhook solo transiciona pagos en REQUIRES_CAPTURE, nunca pisa RELEASED
  app.post(
    '/v1/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!stripe || !webhookSecret || webhookSecret.includes('placeholder')) {
        if (!IS_STAGING_OR_DEV) {
          return res.status(500).json({ error: 'STRIPE_WEBHOOK_NOT_CONFIGURED' });
        }
        return res.status(200).json({ received: true, mode: 'staging_stub' });
      }

      const sig = req.headers['stripe-signature'];
      if (!sig || typeof sig !== 'string') {
        return res.status(400).json({ error: 'MISSING_STRIPE_SIGNATURE' });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err: any) {
        logger.error({ err: err?.message }, '[Stripe Webhook] Firma inválida');
        return res.status(400).send(`Webhook Error: ${err?.message}`);
      }

      try {
        if (event.type === 'account.updated') {
          const account = event.data.object as Stripe.Account;
          const chapusUserId = account.metadata?.chapusUserId;
          if (chapusUserId) {
            let newKyc: JwtClaims['kycStatus'] = 'PENDING_VERIFICATION';
            if (account.charges_enabled && account.payouts_enabled) {
              newKyc = 'VERIFIED';
            } else if (account.requirements?.disabled_reason) {
              newKyc = 'RESTRICTED';
            }
            await db.query(
              `UPDATE users SET kyc_status = $1, updated_at = NOW() WHERE id = $2`,
              [newKyc, chapusUserId]
            );
            logger.info({ chapusUserId, newKyc }, '[Stripe KYC] Actualizado por webhook');
          }
        } else if (
          event.type === 'payment_intent.amount_capturable_updated' ||
          event.type === 'payment_intent.succeeded'
        ) {
          const pi = event.data.object as Stripe.PaymentIntent;
          const requestId = pi.metadata?.requestId;
          if (requestId) {
            const payUpdate = await db.query(
              `UPDATE payments
               SET status = 'ESCROW_HELD',
                   captured_at = COALESCE(captured_at, NOW())
               WHERE stripe_payment_intent_id = $1
                 AND status = 'REQUIRES_CAPTURE'`,
              [pi.id]
            );

            if (payUpdate.rowCount && payUpdate.rowCount > 0) {
              const reqRes = await db.query(
                `UPDATE service_requests sr
                 SET status = CASE WHEN sr.status = 'AWAITING_PAYMENT' THEN 'ASSIGNED'::request_status ELSE sr.status END,
                     version = CASE WHEN sr.status = 'AWAITING_PAYMENT' THEN sr.version + 1 ELSE sr.version END
                 WHERE sr.id = $1
                   AND sr.status IN ('OPEN', 'AWAITING_PAYMENT')
                 RETURNING ${SELECT_REQUEST_COLUMNS}`,
                [requestId]
              );

              if (reqRes.rowCount && reqRes.rowCount > 0) {
                const row: ServiceRequestRow = reqRes.rows[0];
                if (row.assigned_provider_id && row.status === 'ASSIGNED') {
                  broadcaster.emitJobStateTransition(row, 'AWAITING_PAYMENT');
                  emitBookingAssignedToProvider(row, 'ESCROW_HELD');
                } else if (row.status === 'OPEN' && row.pricing_model === 'FAST_MATCH') {
                  await findCandidatesAndDispatch(row);
                }
              }
            }
          }
        }
        return res.status(200).json({ received: true });
      } catch (err: any) {
        logger.error({ err: err?.message }, '[Stripe Webhook] Error procesando evento');
        return res.status(500).json({ error: 'WEBHOOK_HANDLER_FAILED' });
      }
    }
  );

  // FALLO 1.4 CORREGIDO: Stub de subida restringido estrictamente a IS_STAGING_OR_DEV
  if (IS_STAGING_OR_DEV) {
    app.put(
      '/v1/uploads/stub/*',
      express.raw({ type: '*/*', limit: '15mb' }),
      (_req: Request, res: Response) => {
        return res.status(200).send();
      }
    );
  }

  app.use(express.json({ limit: '2mb' }));

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
    logger.info({ providerId, socketId: socket.id }, '[WS /offers] Proveedor conectado');
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

  v1.get('/health', createHealthHandler(db, redis));

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

      const clientIp = req.ip || 'unknown';
      const ipKey = `ratelimit:otp_send:${clientIp}`;
      const ipCount = await redis.incr(ipKey);
      if (ipCount === 1) await redis.expire(ipKey, 900);
      if (!IS_STAGING_OR_DEV && ipCount > 15) {
        return res.status(429).json({
          statusCode: 429,
          errorCode: 'TOO_MANY_OTP_REQUESTS',
          message: 'Demasiadas solicitudes. Espera 15 minutos.',
          timestamp: new Date().toISOString(),
        });
      }

      const otpCode = IS_STAGING_OR_DEV
        ? process.env.STAGE_FIXED_OTP || '123456'
        : String(randomInt(100000, 1000000));

      await redis.set(`otp:${phone}`, otpCode, 'EX', 300);
      await redis.del(`otp_attempts:${phone}`);

      logger.info({ phone, env: process.env.NODE_ENV }, '[Auth] OTP generado');
      return res.status(200).json({
        retryAfterSeconds: 60,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    } catch (err) {
      return next(err);
    }
  };

  v1.post('/auth/otp/send', handleOtpSend);
  v1.post('/auth/otp/request', handleOtpSend);

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

      const attemptsKey = `otp_attempts:${phone}`;
      const attempts = await redis.incr(attemptsKey);
      if (attempts === 1) await redis.expire(attemptsKey, 300);
      if (attempts > 5) {
        await redis.del(`otp:${phone}`);
        return res.status(429).json({
          statusCode: 429,
          errorCode: 'OTP_MAX_ATTEMPTS_EXCEEDED',
          message: 'Máximo de 5 intentos superado. Solicita un nuevo código.',
          timestamp: new Date().toISOString(),
        });
      }

      const storedOtp = await redis.get(`otp:${phone}`);
      const isValidOtp =
        (storedOtp !== null && storedOtp === code) ||
        (IS_STAGING_OR_DEV && code === '123456');

      if (!isValidOtp) {
        return res.status(401).json({
          statusCode: 401,
          errorCode: 'INVALID_OTP',
          message: 'Código OTP inválido o expirado.',
          timestamp: new Date().toISOString(),
        });
      }

      await redis.del(`otp:${phone}`, attemptsKey);

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

      return res.status(200).json({ accessToken, refreshToken, expiresIn, user });
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

      return res.status(200).json({ accessToken, refreshToken, expiresIn, user });
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

  v1.post(
    '/auth/kyc/stripe-onboarding',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = (req as any).user.sub;
        const {
          returnUrl = 'chapuspro://kyc/return',
          refreshUrl = 'chapuspro://kyc/refresh',
        } = req.body || {};

        const userRes = await db.query(
          `SELECT email, phone, stripe_account_id FROM users WHERE id = $1`,
          [userId]
        );
        if (userRes.rowCount === 0) {
          return res.status(404).json({
            statusCode: 404,
            errorCode: 'USER_NOT_FOUND',
            message: 'Usuario no encontrado.',
            timestamp: new Date().toISOString(),
          });
        }

        let stripeAccountId: string | null = userRes.rows[0].stripe_account_id;

        if (!stripe) {
          if (!IS_STAGING_OR_DEV) {
            return res.status(503).json({
              statusCode: 503,
              errorCode: 'STRIPE_KYC_UNAVAILABLE',
              message: 'El servicio de verificación KYC no está configurado.',
              timestamp: new Date().toISOString(),
            });
          }
          stripeAccountId = stripeAccountId || `acct_staging_${userId.slice(0, 8)}`;
          await db.query(
            `UPDATE users SET stripe_account_id = $1, kyc_status = 'VERIFIED' WHERE id = $2`,
            [stripeAccountId, userId]
          );
          return res.status(200).json({
            onboardingUrl: `${returnUrl}?kyc=simulated_verified`,
            stripeAccountId,
          });
        }

        if (!stripeAccountId || stripeAccountId.startsWith('acct_staging_')) {
          const account = await stripe.accounts.create({
            type: 'express',
            country: 'ES',
            email: userRes.rows[0].email || undefined,
            business_type: 'individual',
            capabilities: {
              transfers: { requested: true },
              card_payments: { requested: true },
            },
            metadata: { chapusUserId: userId },
          });
          stripeAccountId = account.id;
          await db.query(
            `UPDATE users SET stripe_account_id = $1, kyc_status = 'PENDING_VERIFICATION' WHERE id = $2`,
            [stripeAccountId, userId]
          );
        }

        const link = await stripe.accountLinks.create({
          account: stripeAccountId,
          refresh_url: refreshUrl,
          return_url: returnUrl,
          type: 'account_onboarding',
          collect: 'eventually_due',
        });

        return res.status(200).json({
          onboardingUrl: link.url,
          stripeAccountId,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  // FALLO 1.6 CORREGIDO: /uploads/presign devuelve https:// detrás de Render
  v1.post(
    '/uploads/presign',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = (req as any).user.sub;
        const {
          contentType = 'image/jpeg',
          fileSizeBytes = 1024,
          purpose = 'ISSUE_ATTACHMENT',
        } = req.body || {};

        const allowedExt: Record<string, string> = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'video/mp4': 'mp4',
        };
        const ext = allowedExt[contentType];
        if (!ext) {
          return res.status(400).json({
            statusCode: 400,
            errorCode: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'Formato de archivo no soportado.',
            timestamp: new Date().toISOString(),
          });
        }

        const now = new Date();
        const fileKey = `${String(purpose).toLowerCase()}/${now.getUTCFullYear()}/${String(
          now.getUTCMonth() + 1
        ).padStart(2, '0')}/${userId}-${randomBytes(8).toString('hex')}.${ext}`;

        if (!process.env.STORAGE_ACCESS_KEY || !process.env.STORAGE_SECRET_KEY) {
          if (!IS_STAGING_OR_DEV) {
            return res.status(503).json({
              statusCode: 503,
              errorCode: 'STORAGE_UNAVAILABLE',
              message: 'Almacenamiento de objetos no configurado.',
              timestamp: new Date().toISOString(),
            });
          }
          const forwardedProto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();
          const proto = forwardedProto || req.protocol || 'https';
          const hostUrl = `${proto}://${req.get('host')}`;
          return res.status(201).json({
            uploadUrl: `${hostUrl}/v1/uploads/stub/${fileKey}`,
            publicFileUrl: `https://placehold.co/800x600/png?text=Chapus+Attachment`,
            fileKey,
            expiresInSeconds: 300,
            requiredHeaders: { 'Content-Type': contentType },
          });
        }

        const cdnBase = process.env.STORAGE_CDN_URL || 'https://cdn-staging.chapus.es';
        const s3 = new S3Client({
          region: process.env.AWS_REGION || 'eu-south-2',
          endpoint: process.env.STORAGE_ENDPOINT || undefined,
          credentials: {
            accessKeyId: process.env.STORAGE_ACCESS_KEY,
            secretAccessKey: process.env.STORAGE_SECRET_KEY,
          },
        });

        const cmd = new PutObjectCommand({
          Bucket: process.env.STORAGE_BUCKET_NAME || 'chapus-staging-eu-south-2',
          Key: fileKey,
          ContentType: contentType,
          ContentLength: Number(fileSizeBytes),
        });

        const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
        return res.status(201).json({
          uploadUrl,
          publicFileUrl: `${cdnBase}/${fileKey}`,
          fileKey,
          expiresInSeconds: 300,
          requiredHeaders: { 'Content-Type': contentType },
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  v1.get('/catalog/categories', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query(`
        SELECT
          id, slug, name,
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

  // FALLO 1.5 CORREGIDO: Transacción atómica en POST /requests (si Stripe falla, hace ROLLBACK)
  v1.post('/requests', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
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

    const dbClient = await db.connect();
    try {
      await dbClient.query('BEGIN');

      const safeZone = deriveApproximateZone(
        approximateZone,
        addressText,
        Number(location.lat),
        Number(location.lng)
      );

      const insertRes = await dbClient.query(
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

      const paymentSheet =
        pricingModel === 'FAST_MATCH'
          ? await createPaymentSheetPayload(
              dbClient,
              clientUserId,
              createdRow.id,
              Number(offeredPriceEur || 65.0)
            )
          : null;

      await dbClient.query('COMMIT');

      const allowImmediateStagingBypass =
        IS_STAGING_OR_DEV &&
        (!stripe || req.headers['x-chapus-immediate-dispatch'] === 'true');

      if (pricingModel === 'BIDDING' || allowImmediateStagingBypass) {
        findCandidatesAndDispatch(createdRow).catch((err) =>
          logger.error({ err: err?.message, requestId: createdRow.id }, '[Dispatcher Error]')
        );
      }

      const dto = ServiceRequestSerializer.toDTO(createdRow, clientUserId);
      return res.status(201).json({ request: dto, paymentSheet });
    } catch (err) {
      await dbClient.query('ROLLBACK');
      return next(err);
    } finally {
      dbClient.release();
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

  // FALLOS 1.2 y 1.5 CORREGIDOS: Exige status = 'OPEN', pricing_model = 'BIDDING' y crea PaymentIntent antes del COMMIT
  v1.post(
    '/requests/:id/bids/:bidId/accept',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      const clientUserId = (req as any).user.sub;
      const { id: requestId, bidId } = req.params;
      const dbClient = await db.connect();

      try {
        await dbClient.query('BEGIN');

        const reqRes = await dbClient.query(
          `SELECT client_id, status, pricing_model FROM service_requests WHERE id = $1 FOR UPDATE`,
          [requestId]
        );
        if (reqRes.rowCount === 0) {
          await dbClient.query('ROLLBACK');
          return res.status(404).json({
            statusCode: 404,
            errorCode: 'NOT_FOUND',
            message: 'Solicitud no encontrada.',
            timestamp: new Date().toISOString(),
          });
        }
        if (reqRes.rows[0].client_id !== clientUserId) {
          await dbClient.query('ROLLBACK');
          return res.status(403).json({
            statusCode: 403,
            errorCode: 'FORBIDDEN',
            message: 'Solo el cliente creador puede aceptar un presupuesto.',
            timestamp: new Date().toISOString(),
          });
        }
        if (reqRes.rows[0].status !== 'OPEN' || reqRes.rows[0].pricing_model !== 'BIDDING') {
          await dbClient.query('ROLLBACK');
          return res.status(409).json({
            statusCode: 409,
            errorCode: 'INVALID_REQUEST_STATE',
            message: `La solicitud ya no admite aceptar presupuestos (estado actual: ${reqRes.rows[0].status}).`,
            timestamp: new Date().toISOString(),
          });
        }

        const bidRes = await dbClient.query(
          `SELECT id, provider_id, amount::float AS amount, status
           FROM bids
           WHERE id = $1 AND request_id = $2
           FOR UPDATE`,
          [bidId, requestId]
        );
        if (bidRes.rowCount === 0) {
          await dbClient.query('ROLLBACK');
          return res.status(404).json({
            statusCode: 404,
            errorCode: 'BID_NOT_FOUND',
            message: 'Presupuesto no encontrado.',
            timestamp: new Date().toISOString(),
          });
        }
        if (bidRes.rows[0].status !== 'PENDING') {
          await dbClient.query('ROLLBACK');
          return res.status(409).json({
            statusCode: 409,
            errorCode: 'BID_NOT_PENDING',
            message: `El presupuesto ya no está pendiente (estado: ${bidRes.rows[0].status}).`,
            timestamp: new Date().toISOString(),
          });
        }

        const winningBid = bidRes.rows[0];

        // Se crea el PaymentIntent ANTES de confirmar los cambios; si Stripe falla, salta al catch y hace ROLLBACK
        const paymentSheet = await createPaymentSheetPayload(
          dbClient,
          clientUserId,
          requestId,
          Number(winningBid.amount)
        );

        await dbClient.query(`UPDATE bids SET status = 'ACCEPTED' WHERE id = $1`, [bidId]);
        await dbClient.query(
          `UPDATE bids SET status = 'REJECTED' WHERE request_id = $1 AND id <> $2`,
          [requestId, bidId]
        );

        const targetStatus: BookingStatus =
          stripe || !IS_STAGING_OR_DEV ? 'AWAITING_PAYMENT' : 'ASSIGNED';

        const updateReq = await dbClient.query(
          `UPDATE service_requests sr
           SET status = $1,
               assigned_provider_id = $2,
               final_agreed_price = $3,
               accepted_at = NOW(),
               version = version + 1
           WHERE sr.id = $4
             AND sr.status = 'OPEN'
           RETURNING ${SELECT_REQUEST_COLUMNS}`,
          [targetStatus, winningBid.provider_id, winningBid.amount, requestId]
        );

        await dbClient.query('COMMIT');

        const updatedRow: ServiceRequestRow = updateReq.rows[0];
        broadcaster.emitJobStateTransition(updatedRow, 'OPEN');

        if (targetStatus === 'ASSIGNED') {
          emitBookingAssignedToProvider(updatedRow, 'ESCROW_HELD');
        }

        return res.status(200).json({
          request: ServiceRequestSerializer.toDTO(updatedRow, clientUserId),
          paymentSheet,
        });
      } catch (err) {
        await dbClient.query('ROLLBACK');
        return next(err);
      } finally {
        dbClient.release();
      }
    }
  );

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

        broadcaster.emitJobStateTransition(row, 'OPEN');
        emitBookingAssignedToProvider(row, 'ESCROW_HELD');

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

  v1.post(
    '/requests/:id/start',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = (req as any).user.sub;
        const requestId = req.params.id;

        const updateRes = await db.query(
          `UPDATE service_requests sr
           SET status = 'IN_PROGRESS',
               version = version + 1
           WHERE sr.id = $1
             AND sr.assigned_provider_id = $2
             AND sr.status = 'ASSIGNED'
           RETURNING ${SELECT_REQUEST_COLUMNS}`,
          [requestId, userId]
        );

        if (updateRes.rowCount === 0) {
          return res.status(409).json({
            statusCode: 409,
            errorCode: 'INVALID_STATE_TRANSITION',
            message: 'Solo el profesional asignado puede iniciar un servicio en estado ASSIGNED.',
            timestamp: new Date().toISOString(),
          });
        }

        const row: ServiceRequestRow = updateRes.rows[0];
        broadcaster.emitJobStateTransition(row, 'ASSIGNED');

        return res.status(200).json(ServiceRequestSerializer.toDTO(row, userId));
      } catch (err) {
        return next(err);
      }
    }
  );

  // FALLO 1.3 y DECISIÓN 2.1 CORREGIDOS: Solo el cliente creador (client_id === userId) puede completar y liberar el Escrow
  v1.post(
    '/requests/:id/complete',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = (req as any).user.sub;
        const requestId = req.params.id;

        const checkRes = await db.query(
          `SELECT client_id, assigned_provider_id, status, final_agreed_price
           FROM service_requests WHERE id = $1`,
          [requestId]
        );
        if (checkRes.rowCount === 0) {
          return res.status(404).json({
            statusCode: 404,
            errorCode: 'NOT_FOUND',
            message: 'Solicitud no encontrada.',
            timestamp: new Date().toISOString(),
          });
        }

        const current = checkRes.rows[0];
        if (current.client_id !== userId) {
          return res.status(403).json({
            statusCode: 403,
            errorCode: 'FORBIDDEN_ONLY_CLIENT_CAN_COMPLETE',
            message: 'Únicamente el cliente titular puede confirmar la finalización y liberar el pago.',
            timestamp: new Date().toISOString(),
          });
        }

        if (!['ASSIGNED', 'IN_PROGRESS'].includes(current.status)) {
          return res.status(409).json({
            statusCode: 409,
            errorCode: 'INVALID_STATE_TRANSITION',
            message: `No se puede completar un servicio en estado ${current.status}.`,
            timestamp: new Date().toISOString(),
          });
        }

        if (stripe && current.assigned_provider_id) {
          const payRes = await db.query(
            `SELECT p.stripe_payment_intent_id, p.provider_payout::float AS payout, p.status AS pay_status, u.stripe_account_id
             FROM payments p
             JOIN users u ON u.id = $2
             WHERE p.request_id = $1`,
            [requestId, current.assigned_provider_id]
          );

          if (payRes.rowCount && payRes.rowCount > 0) {
            const { stripe_payment_intent_id, payout, pay_status, stripe_account_id } = payRes.rows[0];
            if (
              stripe_payment_intent_id &&
              !stripe_payment_intent_id.startsWith('pi_staging_') &&
              pay_status !== 'RELEASED'
            ) {
              const capturedPi = await stripe.paymentIntents.capture(stripe_payment_intent_id);
              let transferId: string | null = null;

              if (
                stripe_account_id &&
                !stripe_account_id.startsWith('acct_staging_') &&
                capturedPi.latest_charge
              ) {
                const transfer = await stripe.transfers.create(
                  {
                    amount: Math.round(Number(payout) * 100),
                    currency: 'eur',
                    destination: stripe_account_id,
                    transfer_group: `CHAPUS_REQ_${requestId}`,
                    source_transaction: capturedPi.latest_charge as string,
                  },
                  { idempotencyKey: `transfer_${requestId}` }
                );
                transferId = transfer.id;
              }

              await db.query(
                `UPDATE payments
                 SET status = 'RELEASED',
                     provider_id = $1,
                     stripe_transfer_id = COALESCE($2, stripe_transfer_id),
                     released_at = NOW()
                 WHERE request_id = $3`,
                [current.assigned_provider_id, transferId, requestId]
              );
            }
          }
        }

        const updateRes = await db.query(
          `UPDATE service_requests sr
           SET status = 'COMPLETED',
               completed_at = NOW(),
               version = version + 1
           WHERE sr.id = $1
           RETURNING ${SELECT_REQUEST_COLUMNS}`,
          [requestId]
        );

        const row: ServiceRequestRow = updateRes.rows[0];

        if (row.assigned_provider_id) {
          await db.query(
            `UPDATE users SET completed_jobs_count = completed_jobs_count + 1 WHERE id = $1`,
            [row.assigned_provider_id]
          );
        }

        broadcaster.emitJobStateTransition(row, current.status);
        return res.status(200).json(ServiceRequestSerializer.toDTO(row, userId));
      } catch (err) {
        return next(err);
      }
    }
  );

  v1.post(
    '/admin/cleanup-staging',
    async (req: Request, res: Response, next: NextFunction) => {
      if (!IS_STAGING_OR_DEV) {
        return res.status(403).json({
          statusCode: 403,
          errorCode: 'FORBIDDEN_IN_PROD',
          message: 'Operación permitida únicamente en staging.',
          timestamp: new Date().toISOString(),
        });
      }

      const expectedSecret = process.env.ADMIN_CLEANUP_SECRET || JWT_SECRET;
      const providedSecret = String(req.headers['x-admin-secret'] || '');
      const bufExpected = Buffer.from(expectedSecret);
      const bufProvided = Buffer.from(providedSecret);

      if (
        bufExpected.length !== bufProvided.length ||
        !timingSafeEqual(bufExpected, bufProvided)
      ) {
        return res.status(401).json({
          statusCode: 401,
          errorCode: 'UNAUTHORIZED_ADMIN',
          message: 'Cabecera x-admin-secret inválida o ausente.',
          timestamp: new Date().toISOString(),
        });
      }

      try {
        const delRes = await db.query(`
          DELETE FROM service_requests
          WHERE status = 'OPEN'
            AND client_id IN (SELECT id FROM users WHERE phone = '+34600000902')
        `);
        return res.status(200).json({
          cleanedOpenRequestsCount: delRes.rowCount || 0,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.use('/v1', v1);

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
