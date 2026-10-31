import { useQuery } from '@tanstack/react-query';
import { useApi } from '@chapus/api';
import type { NearbyRequest, ServiceRequest } from '@chapus/core';
import { useAlerts } from './store';

/**
 * Datos completos de una alerta. La del WebSocket ya los trae; la del push solo trae el id,
 * así que se pide el detalle con GET /requests/{id}. La distancia solo viene por WS.
 */
export function useAlertRequest(id: string) {
  const api = useApi();
  const fromAlert = useAlerts((s) => s.alerts.find((a) => a.requestId === id)?.request);

  const fetched = useQuery({
    queryKey: ['requests', id],
    queryFn: () => api.getRequest(id),
    enabled: !fromAlert,
  });

  const request: (ServiceRequest & Partial<Pick<NearbyRequest, 'distanceKm'>>) | null = fromAlert ?? fetched.data ?? null;
  return { request, isLoading: !fromAlert && fetched.isLoading };
}
