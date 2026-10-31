import { useQuery } from '@tanstack/react-query';
import { isApiError, queryKeys, useApi } from '@chapus/api';
import type { NearbyRequest, ServiceRequest } from '@chapus/core';
import { useAlerts } from './store';

/**
 * Datos completos de una alerta. La del WebSocket ya los trae; la del push solo trae el id,
 * así que se pide el detalle con GET /requests/{id}. La distancia solo viene por WS.
 *
 * `lost` indica que la oportunidad ya no es de este profesional: otro ganó la carrera
 * (geo:job_taken) o el serializador deniega el acceso (403 RGPD_ACCESS_DENIED) porque la
 * solicitud dejó de estar OPEN.
 */
export function useAlertRequest(id: string) {
  const api = useApi();
  const alert = useAlerts((s) => s.alerts.find((a) => a.requestId === id));

  const fetched = useQuery({
    queryKey: queryKeys.request(id),
    queryFn: () => api.getRequest(id),
    enabled: !alert?.request,
  });

  const request: (ServiceRequest & Partial<Pick<NearbyRequest, 'distanceKm'>>) | null =
    alert?.request ?? fetched.data ?? null;
  const denied = isApiError(fetched.error, 403) || isApiError(fetched.error, 404);
  const lost = alert?.takenAt !== undefined || denied || (request !== null && request.status !== 'OPEN');

  return { request, lost, isLoading: !alert?.request && fetched.isLoading };
}
