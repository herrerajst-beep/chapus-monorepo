import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys, useApi } from '@chapus/api';
import { offersSocket } from '@/lib/api';
import { payoutKey } from './useJobEvents';

/**
 * Trabajo adjudicado. Las transiciones llegan por `job:updated` / `booking:assigned`
 * (useJobEvents); aquí no hay polling. Solo se resincroniza por REST cuando pudo haberse
 * perdido un evento: al volver a primer plano y al reconectar el socket.
 */
export function useAssignedJob(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  const job = useQuery({ queryKey: queryKeys.request(id), queryFn: () => api.getRequest(id) });
  const payout = useQuery<number>({ queryKey: payoutKey(id), enabled: false });

  useEffect(() => {
    // El adjudicatario necesita /offers aunque se haya puesto "No disponible".
    if (!offersSocket.connected) offersSocket.connect();
    const resync = () => void qc.invalidateQueries({ queryKey: queryKeys.request(id), exact: true });
    offersSocket.io.on('reconnect', resync);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && resync());
    return () => {
      offersSocket.io.off('reconnect', resync);
      sub.remove();
    };
  }, [id, qc]);

  return { ...job, guaranteedPayoutEur: payout.data ?? null };
}
