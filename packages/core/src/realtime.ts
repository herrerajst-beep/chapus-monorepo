import type { Bid, KycStatus, PricingModel, ServiceRequest } from './domain';

/** Ventana durante la que un FAST_MATCH es aceptable (alineado con el TTL de push del dispatcher). */
export const FAST_MATCH_ALERT_TTL_MS = 45_000;

export const NAMESPACES = { offers: '/offers', bookings: '/bookings' } as const;

// ---------------------------------------------------------------------------
// /offers: proveedores con kycStatus VERIFIED en el claim del JWT
// ---------------------------------------------------------------------------

export interface JobAlertPayload {
  request: ServiceRequest;
  distanceKm: number;
}

/** El dispatcher acepta la entrega si algún dispositivo responde `received: true`. */
export interface JobAlertAck {
  received: true;
  /** Hora del móvil al recibir: permite al backend medir la latencia emit→ACK. */
  timestamp: number;
}

export interface JobTakenPayload {
  requestId: string;
  takenAt: string;
}

export interface OffersServerEvents {
  'geo:job_alert': (payload: JobAlertPayload, ack: (res: JobAlertAck) => void) => void;
  'geo:job_taken': (payload: JobTakenPayload) => void;
}

// ---------------------------------------------------------------------------
// /bookings: clientes siguiendo sus solicitudes (sala `request:{id}`)
// ---------------------------------------------------------------------------

export interface RequestUpdatedPayload {
  request: ServiceRequest;
  updatedAt: string;
}

export interface BidCreatedPayload {
  requestId: string;
  bid: Bid;
}

export interface BookingsServerEvents {
  'request:updated': (payload: RequestUpdatedPayload) => void;
  'request:bid_created': (payload: BidCreatedPayload) => void;
}

export interface BookingsClientEvents {
  'request:subscribe': (requestId: string, ack: (res: { ok: boolean }) => void) => void;
}

// ---------------------------------------------------------------------------
// Errores del handshake (`connect_error` → `err.data`)
// ---------------------------------------------------------------------------

export type SocketAuthErrorData =
  | { statusCode: 401; errorCode: 'UNAUTHORIZED' | 'INVALID_TOKEN' }
  | { statusCode: 403; errorCode: 'KYC_VERIFICATION_REQUIRED'; kycStatus: KycStatus };

export function socketErrorData(err: unknown): SocketAuthErrorData | null {
  const data = (err as { data?: unknown } | null)?.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as { statusCode?: unknown }).statusCode;
  return code === 401 || code === 403 ? (data as SocketAuthErrorData) : null;
}

// ---------------------------------------------------------------------------
// Push de respaldo (FCM/APNs): todos los valores de `data` llegan como string
// ---------------------------------------------------------------------------

export interface JobAlertPushData {
  type: 'NEW_JOB_ALERT';
  requestId: string;
  pricingModel: PricingModel;
  offeredPriceEur: string;
  distanceKm: string;
}

export function isJobAlertPushData(data: unknown): data is JobAlertPushData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'NEW_JOB_ALERT' &&
    typeof (data as { requestId?: unknown }).requestId === 'string'
  );
}

/** Un FAST_MATCH caducado no debe mostrarse (el push puede llegar tarde). */
export function isAlertExpired(req: Pick<ServiceRequest, 'pricingModel' | 'createdAt'>, now = Date.now()) {
  if (req.pricingModel !== 'FAST_MATCH') return false;
  return now - Date.parse(req.createdAt) > FAST_MATCH_ALERT_TTL_MS;
}
