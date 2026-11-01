import createClient from 'openapi-fetch';
import type { paths } from '@chapus/api-contract';
import type {
  AuthSession,
  Bid,
  BidCreate,
  CheckoutResponse,
  ErrorResponse,
  GeoPoint,
  NearbyRequest,
  OtpChannel,
  PresignUploadRequest,
  PresignUploadResponse,
  ServiceCategory,
  ServiceRequest,
  ServiceRequestCreate,
  UserProfile,
  UserRole,
} from '@chapus/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorResponse | undefined,
  ) {
    super(body?.message ?? `API ${status}`);
    this.name = 'ApiError';
  }

  get errorCode() {
    return this.body?.errorCode;
  }
}

export const isApiError = (e: unknown, status?: number): e is ApiError =>
  e instanceof ApiError && (status === undefined || e.status === status);

export interface ChapusApiOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  /** Se invoca ante un 401 en una petición autenticada (sesión revocada). */
  onUnauthorized?: () => void;
}

type FetchResult = Promise<{ data?: unknown; error?: unknown; response: Response }>;

async function unwrap<T>(call: FetchResult): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) {
    const body = typeof error === 'object' && error !== null && 'errorCode' in error ? (error as ErrorResponse) : undefined;
    throw new ApiError(response.status, body);
  }
  return data as T;
}

export function createChapusApi({ baseUrl, getToken, onUnauthorized }: ChapusApiOptions) {
  // Cliente sin token para login/refresh: evita que pedir el token dispare otro refresh.
  const pub = createClient<paths>({ baseUrl });
  const http = createClient<paths>({ baseUrl });

  // Los middlewares no devuelven nada: openapi-fetch exige `instanceof Response/Request` a lo
  // que se devuelve, y en React Native las respuestas vacías (204) no siempre lo cumplen.
  // Sin valor de retorno conserva el objeto original.
  http.use({
    async onRequest({ request }) {
      const token = await getToken();
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
    },
    onResponse({ response }) {
      if (response.status === 401) onUnauthorized?.();
    },
  });

  const byId = (id: string) => ({ params: { path: { id } } });

  return {
    // Auth passwordless
    requestOtp: (phone: string, channel: OtpChannel) =>
      unwrap<void>(pub.POST('/auth/otp/request', { body: { phone, channel } })),
    verifyOtp: (phone: string, code: string, requestedRole: UserRole, fcmToken?: string | null) =>
      unwrap<AuthSession>(pub.POST('/auth/otp/verify', { body: { phone, code, requestedRole, fcmToken } })),
    refresh: (refreshToken: string) =>
      unwrap<AuthSession>(pub.POST('/auth/refresh', { body: { refreshToken } })),

    me: () => unwrap<UserProfile>(http.GET('/auth/me')),
    startStripeOnboarding: (returnUrl: string, refreshUrl: string) =>
      unwrap<{ onboardingUrl: string; stripeAccountId: string }>(
        http.POST('/auth/kyc/stripe-onboarding', { body: { returnUrl, refreshUrl } }),
      ),

    // Almacenamiento
    presignUpload: (body: PresignUploadRequest) =>
      unwrap<PresignUploadResponse>(http.POST('/uploads/presign', { body })),

    // Catálogo
    categories: () => unwrap<ServiceCategory[]>(pub.GET('/catalog/categories')),

    // Geolocalización
    heartbeat: (location: GeoPoint, isOnline: boolean, fcmToken?: string) =>
      unwrap<void>(http.PATCH('/geo/provider-heartbeat', { body: { location, isOnline, fcmToken } })),
    nearbyRequests: (at: GeoPoint, radiusKm?: number) =>
      unwrap<NearbyRequest[]>(http.GET('/geo/nearby-requests', { params: { query: { ...at, radiusKm } } })),

    // Solicitudes
    createRequest: (body: ServiceRequestCreate) => unwrap<CheckoutResponse>(http.POST('/requests', { body })),
    getRequest: (id: string) => unwrap<ServiceRequest>(http.GET('/requests/{id}', byId(id))),
    /** 403 KYC_VERIFICATION_REQUIRED · 409 JOB_ALREADY_TAKEN */
    fastAccept: (id: string) => unwrap<ServiceRequest>(http.POST('/requests/{id}/fast-accept', byId(id))),
    listBids: (id: string) => unwrap<Bid[]>(http.GET('/requests/{id}/bids', byId(id))),
    createBid: (id: string, body: BidCreate) =>
      unwrap<Bid>(http.POST('/requests/{id}/bids', { ...byId(id), body })),
    acceptBid: (id: string, bidId: string) =>
      unwrap<CheckoutResponse>(http.POST('/requests/{id}/bids/{bidId}/accept', { params: { path: { id, bidId } } })),

    // Ciclo de vida
    startJob: (id: string) => unwrap<ServiceRequest>(http.POST('/requests/{id}/start', byId(id))),
    completeJob: (id: string) => unwrap<ServiceRequest>(http.POST('/requests/{id}/complete', byId(id))),
  };
}

export type ChapusApi = ReturnType<typeof createChapusApi>;
