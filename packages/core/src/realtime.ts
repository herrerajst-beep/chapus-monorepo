import type { Bid, BookingStatus, KycStatus, PricingModel, ServiceRequest } from './domain';

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

/**
 * Respuesta al callback del emit (`DeviceAckPayload` del dispatcher). Basta con que un
 * dispositivo del proveedor responda `received: true`; el Δt emit→ACK lo mide el servidor
 * con hrtime y lo registra como métrica `ws_dispatch_ack`.
 */
export interface JobAlertAck {
  received: true;
  deviceId: string;
  clientTimestamp: number;
}

export interface JobTakenPayload {
  requestId: string;
  takenAt: string;
}

/**
 * `job:updated` (JobStateBroadcaster): un DTO serializado para cada destinatario.
 * El cliente propietario siempre lo recibe sin máscara; el proveedor vinculado, con
 * `addressText: null` hasta ASSIGNED.
 */
export interface JobUpdatedPayload {
  job: ServiceRequest;
  previousStatus: BookingStatus;
  currentStatus: BookingStatus;
  transitionedAt: string;
}

/**
 * `booking:assigned`: Stripe confirmó la retención del Escrow. El job llega con la
 * dirección exacta. FORMA SUPUESTA: el material recibido describe el evento pero no su
 * emisor; confirmar con Argon.
 */
export interface BookingAssignedPayload {
  job: ServiceRequest;
  guaranteedPayoutEur: number;
}

export interface OffersServerEvents {
  'geo:job_alert': (payload: JobAlertPayload, ack: (res: JobAlertAck) => void) => void;
  'geo:job_taken': (payload: JobTakenPayload) => void;
  'job:updated': (payload: JobUpdatedPayload) => void;
  'booking:assigned': (payload: BookingAssignedPayload) => void;
}

// ---------------------------------------------------------------------------
// /bookings: clientes siguiendo sus solicitudes (sala `request:{id}`)
// ---------------------------------------------------------------------------

export interface BidCreatedPayload {
  requestId: string;
  bid: Bid;
}

export interface BookingsServerEvents {
  'job:updated': (payload: JobUpdatedPayload) => void;
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
  /** La dirección exacta nunca viaja por FCM/APNs. */
  approximateZone?: string;
  /** Solo en versiones anteriores del dispatcher. */
  offeredPriceEur?: string;
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
