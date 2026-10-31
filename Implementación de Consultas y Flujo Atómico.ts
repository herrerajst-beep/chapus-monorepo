// packages/backend/src/modules/bookings/bookings.service.ts
import { Pool } from 'pg';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { GeoDispatcherService } from '../dispatch/geo-dispatcher.service';
import { Redis } from 'ioredis';

export class BookingsService {
  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly realtime: RealtimeGateway,
    private readonly dispatcher: GeoDispatcherService
  ) {}

  /**
   * GET /requests/{id}
   * Devuelve el detalle estricto extrayendo lat/lng desde PostGIS y contando ofertas activas.
   */
  async getRequestById(requestId: string) {
    const query = `
      SELECT 
        sr.id,
        sr.client_id AS "clientId",
        sr.assigned_provider_id AS "assignedProviderId",
        sr.category_id AS "categoryId",
        sr.pricing_model AS "pricingModel",
        sr.offered_price::float AS "offeredPriceEur",
        sr.final_agreed_price::float AS "finalAgreedPriceEur",
        json_build_object(
          'lat', ST_Y(sr.location::geometry),
          'lng', ST_X(sr.location::geometry)
        ) AS "location",
        sr.address_text AS "addressText",
        sr.description,
        COALESCE(sr.photo_urls, '{}') AS "photoUrls",
        sr.status,
        (SELECT COUNT(*)::int FROM bids b WHERE b.request_id = sr.id AND b.status = 'PENDING') AS "bidsCount",
        sr.version,
        sr.scheduled_at AS "scheduledAt",
        sr.created_at AS "createdAt",
        sr.accepted_at AS "acceptedAt",
        sr.completed_at AS "completedAt"
      FROM service_requests sr
      WHERE sr.id = $1;
    `;
    const { rows } = await this.db.query(query, [requestId]);
    if (rows.length === 0) return null;
    return rows[0];
  }

  /**
   * GET /requests/{id}/bids
   * Obtiene todas las ofertas con el resumen de reputación del autónomo en un solo JOIN.
   */
  async getBidsByRequestId(requestId: string) {
    const query = `
      SELECT 
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
      ORDER BY b.created_at DESC;
    `;
    const { rows } = await this.db.query(query, [requestId]);
    return rows;
  }

  /**
   * POST /requests/{id}/fast-accept
   * Transacción atómica + Emisión de request:updated (al cliente) y geo:job_taken (a otros proveedores)
   */
  async acceptFastMatchJob(requestId: string, providerId: string, kycStatus: string) {
    if (kycStatus !== 'VERIFIED') {
      const err: any = new Error('KYC_VERIFICATION_REQUIRED');
      err.statusCode = 403;
      throw err;
    }

    // 1. Filtro ultrarrápido en Redis para proteger PostgreSQL ante ráfagas concurrentes
    const lockKey = `lock:fast_accept:${requestId}`;
    const lockAcquired = await this.redis.set(lockKey, providerId, 'NX', 'PX', 3000);
    if (!lockAcquired) {
      const err: any = new Error('JOB_ALREADY_TAKEN');
      err.statusCode = 409;
      throw err;
    }

    // 2. Actualización atómica en PostgreSQL
    const updateQuery = `
      UPDATE service_requests
      SET 
        status = 'ASSIGNED',
        assigned_provider_id = $1,
        final_agreed_price = offered_price,
        accepted_at = NOW(),
        version = version + 1
      WHERE id = $2
        AND status = 'OPEN'
        AND pricing_model = 'FAST_MATCH'
      RETURNING id;
    `;

    const { rowCount } = await this.db.query(updateQuery, [providerId, requestId]);
    if (rowCount === 0) {
      const err: any = new Error('JOB_ALREADY_TAKEN');
      err.statusCode = 409;
      throw err;
    }

    const updatedRequest = await this.getRequestById(requestId);

    // 3. Emitir en vivo al Cliente que su servicio exprés ha sido capturado
    this.realtime.emitRequestUpdated(requestId, updatedRequest);

    // 4. Obtener los proveedores notificados en este radio y emitirles geo:job_taken
    const notifiedProviders = await this.redis.smembers(`notified_providers:${requestId}`);
    this.dispatcher.broadcastJobTaken(requestId, notifiedProviders, providerId);

    return updatedRequest;
  }
}