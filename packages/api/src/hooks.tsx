import { createContext, useContext, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BidCreate, GeoPoint, ServiceRequest, ServiceRequestCreate } from '@chapus/core';
import { isApiError, type ChapusApi } from './client';

const ApiContext = createContext<ChapusApi | null>(null);

export function ApiProvider({ api, children }: { api: ChapusApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ChapusApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi() fuera de <ApiProvider>');
  return api;
}

export const queryKeys = {
  me: ['me'] as const,
  categories: ['catalog', 'categories'] as const,
  nearby: (at: GeoPoint | null, radiusKm: number) => ['geo', 'nearby', at?.lat, at?.lng, radiusKm] as const,
  request: (id: string) => ['requests', id] as const,
  bids: (id: string) => ['requests', id, 'bids'] as const,
};

/** No reintentar errores de cliente (4xx): solo fallos de red o 5xx. */
export const shouldRetry = (failureCount: number, error: unknown) =>
  !(isApiError(error) && error.status < 500) && failureCount < 3;

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me });
}

export function useCategories() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.categories, queryFn: api.categories, staleTime: 10 * 60_000 });
}

export function useNearbyRequests(at: GeoPoint | null, radiusKm = 10, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.nearby(at, radiusKm),
    queryFn: () => api.nearbyRequests(at!, radiusKm),
    enabled: enabled && at !== null,
    refetchInterval: 30_000,
  });
}

/** Detalle de la solicitud; los sockets lo mantienen al día vía setQueryData. */
export function useRequest(id: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.request(id), queryFn: () => api.getRequest(id) });
}

export function useBids(requestId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.bids(requestId),
    queryFn: () => api.listBids(requestId),
    enabled,
  });
}

export function useCreateRequest() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ServiceRequestCreate) => api.createRequest(body),
    onSuccess: ({ request }) => qc.setQueryData(queryKeys.request(request.id), request),
  });
}

export function useFastAccept() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.fastAccept(id),
    onSuccess: (request) => qc.setQueryData(queryKeys.request(request.id), request),
    onSettled: () => qc.invalidateQueries({ queryKey: ['geo', 'nearby'] }),
  });
}

export function useCreateBid(requestId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BidCreate) => api.createBid(requestId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['geo', 'nearby'] }),
  });
}

export function useAcceptBid(requestId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bidId: string) => api.acceptBid(requestId, bidId),
    onSuccess: ({ request }) => qc.setQueryData(queryKeys.request(request.id), request),
  });
}

export function useJobLifecycle(requestId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const store = (r: ServiceRequest) => qc.setQueryData(queryKeys.request(requestId), r);
  return {
    start: useMutation({ mutationFn: () => api.startJob(requestId), onSuccess: store }),
    complete: useMutation({ mutationFn: () => api.completeJob(requestId), onSuccess: store }),
  };
}
