import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys, useApi } from '@chapus/api';
import type { OffersServerEvents, ServiceRequest } from '@chapus/core';
import { offersSocket } from '@/lib/api';

const POLL_WHILE_PAYING_MS = 5_000;

/**
 * Trabajo adjudicado en vivo. Fuentes, por orden de rapidez:
 * 1. `job:updated` en /offers (propuesto a Argon).
 * 2. Sondeo de GET /requests/{id} cada 5 s mientras está en AWAITING_PAYMENT.
 * 3. Recarga al volver la app a primer plano.
 * Al pasar a ASSIGNED vibra una vez para que el profesional sepa que puede salir.
 */
export function useAssignedJob(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: queryKeys.request(id),
    queryFn: () => api.getRequest(id),
    refetchInterval: (q) => (q.state.data?.status === 'AWAITING_PAYMENT' ? POLL_WHILE_PAYING_MS : false),
  });

  useEffect(() => {
    const onUpdated: OffersServerEvents['job:updated'] = ({ request }) => {
      if (request.id !== id) return;
      qc.setQueryData<ServiceRequest>(queryKeys.request(id), (prev) =>
        prev && prev.version > request.version ? prev : request,
      );
    };
    offersSocket.on('job:updated', onUpdated);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void qc.invalidateQueries({ queryKey: queryKeys.request(id) });
    });
    return () => {
      offersSocket.off('job:updated', onUpdated);
      sub.remove();
    };
  }, [id, qc]);

  const prevStatus = useRef(job.data?.status);
  const status = job.data?.status;
  useEffect(() => {
    if (prevStatus.current === 'AWAITING_PAYMENT' && status === 'ASSIGNED') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    prevStatus.current = status;
  }, [status]);

  return job;
}
