import { ApiError, type createChapusApi } from '@chapus/api';
import type { AuthSession, GeoPoint, NearbyRequest, ServiceCategory, UserProfile } from '@chapus/core';
import { DIAGNOSTICS_ENABLED } from '@/features/diagnostics/latency';

type ChapusApi = ReturnType<typeof createChapusApi>;

/**
 * Modo demo: entra sin backend para auditar la interfaz (render del banner, transiciones de
 * oportunidad perdida) en un dispositivo físico. Solo existe en desarrollo y staging, igual
 * que el panel de diagnóstico; en producción el botón no aparece.
 */
export const DEMO_ENABLED = DIAGNOSTICS_ENABLED;

/** Los tokens demo no son JWT válidos: el prefijo basta para reconocer la sesión. */
export const DEMO_TOKEN_PREFIX = 'demo.';

/** Solicitud que «otro profesional» se lleva entre el listado y la ficha (403 RGPD). */
const TAKEN_ID = 'demo-taken';

const DEMO_USER: UserProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  email: null,
  phone: '+34600000000',
  fullName: 'Profesional demo',
  activeRole: 'PROVIDER',
  kycStatus: 'VERIFIED',
  stripeAccountId: null,
  isOnline: false,
  serviceRadiusKm: 10,
  ratingAvg: 4.9,
};

export const demoSession = (): AuthSession => ({
  accessToken: `${DEMO_TOKEN_PREFIX}provider`,
  refreshToken: `${DEMO_TOKEN_PREFIX}refresh`,
  // Sin backend no hay renovación posible: la sesión demo no caduca en la práctica.
  expiresIn: 10 * 365 * 24 * 3600,
  user: DEMO_USER,
});

const CATEGORIES: ServiceCategory[] = [
  { id: 101, slug: 'limpieza-expres', name: 'Limpieza exprés', allowedModels: ['FAST_MATCH'], baseFixedPriceEur: 55, platformFeePercent: 15 },
  { id: 102, slug: 'fontaneria', name: 'Fontanería', allowedModels: ['FAST_MATCH', 'BIDDING'], baseFixedPriceEur: 65, platformFeePercent: 15 },
  { id: 103, slug: 'reformas', name: 'Pequeñas reformas', allowedModels: ['BIDDING'], baseFixedPriceEur: 0, platformFeePercent: 12 },
];

const apiError = (statusCode: number, errorCode: string, message: string) =>
  new ApiError(statusCode, { statusCode, errorCode, message, timestamp: new Date().toISOString() });

const nearby = (at: GeoPoint): NearbyRequest[] => {
  const now = new Date().toISOString();
  const base = {
    clientId: 'demo-client',
    addressText: null,
    isAddressMasked: true,
    photoUrls: [],
    scheduledAt: null,
    assignedProviderId: null,
    finalAgreedPriceEur: null,
    status: 'OPEN' as const,
    version: 1,
    createdAt: now,
    acceptedAt: null,
    completedAt: null,
  };
  // Coordenadas truncadas a 2 decimales, como hace el serializador del backend.
  const near = (dLat: number, dLng: number) => ({
    lat: Math.round((at.lat + dLat) * 100) / 100,
    lng: Math.round((at.lng + dLng) * 100) / 100,
  });
  return [
    {
      ...base,
      id: 'demo-open',
      categoryId: 103,
      pricingModel: 'BIDDING',
      offeredPriceEur: null,
      location: near(0.01, 0.01),
      approximateZone: 'Zona demo',
      description: 'Cambiar dos enchufes y colgar una lámpara (demo).',
      bidsCount: 2,
      distanceKm: 1.4,
    },
    {
      ...base,
      id: TAKEN_ID,
      categoryId: 102,
      pricingModel: 'FAST_MATCH',
      offeredPriceEur: 65,
      location: near(-0.01, 0.02),
      approximateZone: 'Zona demo',
      description: 'Ábrela: otro profesional la acepta antes (prueba del 403).',
      bidsCount: 0,
      distanceKm: 2.1,
    },
  ];
};

/**
 * API sin red para la sesión demo. Lo que no tiene sentido sin backend (pagos, KYC, subidas)
 * falla con un error explícito en lugar de quedarse colgado.
 */
export function createDemoApi(): Partial<ChapusApi> {
  let lastPosition: GeoPoint = { lat: 40.42, lng: -3.7 };
  return {
    me: async () => DEMO_USER,
    categories: async () => CATEGORIES,
    heartbeat: async (location) => {
      lastPosition = location;
    },
    nearbyRequests: async (at) => nearby(at),
    getRequest: async (id) => {
      if (id === TAKEN_ID) throw apiError(403, 'RGPD_ACCESS_DENIED', 'La solicitud ya no está disponible.');
      const found = nearby(lastPosition).find((r) => r.id === id);
      if (!found) throw apiError(404, 'NOT_FOUND', 'Solicitud no encontrada.');
      return found;
    },
    // Siempre pierde la carrera: es el caso que hay que validar visualmente (409 sin texto rojo).
    fastAccept: async () => {
      await new Promise((r) => setTimeout(r, 400));
      throw apiError(409, 'REQUEST_ALREADY_TAKEN', 'Otro profesional aceptó primero.');
    },
    listBids: async () => [],
  };
}

export const demoUnavailable = () =>
  Promise.reject(apiError(503, 'DEMO_MODE', 'No disponible en modo demo.'));
