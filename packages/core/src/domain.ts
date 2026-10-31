import type { components } from '@chapus/api-contract';

type Schemas = components['schemas'];

// Contrato v1.1.0 en modo estricto: los tipos se usan tal cual, sin reforzarlos aquí.
export type GeoPoint = Schemas['GeoPoint'];
export type UserRole = Schemas['UserRole'];
export type KycStatus = Schemas['KycStatus'];
export type PricingModel = Schemas['PricingModel'];
export type BookingStatus = Schemas['BookingStatus'];
export type BidStatus = Schemas['BidStatus'];
export type OtpChannel = Schemas['OtpChannel'];
export type ErrorResponse = Schemas['ErrorResponse'];
export type UserProfile = Schemas['UserProfile'];
export type AuthSession = Schemas['AuthSessionResponse'];
export type ServiceCategory = Schemas['ServiceCategory'];
export type ServiceRequestCreate = Schemas['ServiceRequestCreate'];
export type ServiceRequest = Schemas['ServiceRequestResponse'];
export type NearbyRequest = Schemas['NearbyRequest'];
export type BidCreate = Schemas['BidCreate'];
export type Bid = Schemas['BidResponse'];
export type PaymentSheetPayload = Schemas['StripePaymentSheetPayload'];
export type CheckoutResponse = Schemas['CheckoutResponse'];
export type PresignUploadRequest = Schemas['PresignUploadRequest'];
export type PresignUploadResponse = Schemas['PresignUploadResponse'];

export const ACTIVE_STATUSES: readonly BookingStatus[] = [
  'OPEN',
  'AWAITING_PAYMENT',
  'ASSIGNED',
  'IN_PROGRESS',
];

export const STATUS_LABEL: Record<BookingStatus, string> = {
  OPEN: 'Buscando profesional',
  AWAITING_PAYMENT: 'Pendiente de pago',
  ASSIGNED: 'Profesional asignado',
  IN_PROGRESS: 'En curso',
  COMPLETED: 'Completado',
  DISPUTED: 'En disputa',
  CANCELLED: 'Cancelado',
};

/** Precio a mostrar: el pactado si existe, si no el ofertado. */
export const displayPrice = (r: Pick<ServiceRequest, 'finalAgreedPriceEur' | 'offeredPriceEur'>) =>
  r.finalAgreedPriceEur ?? r.offeredPriceEur ?? null;
