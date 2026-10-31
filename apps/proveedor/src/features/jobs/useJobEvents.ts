import { useEffect, useRef } from 'react';
import { router, usePathname } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@chapus/api';
import type { OffersServerEvents, ServiceRequest } from '@chapus/core';
import { offersSocket } from '@/lib/api';

export const payoutKey = (id: string) => ['requests', id, 'payout'] as const;

/** Guarda el DTO más reciente (por `version`) y avisa si acaba de pasar a ASSIGNED. */
function storeJob(qc: QueryClient, job: ServiceRequest) {
  const prev = qc.getQueryData<ServiceRequest>(queryKeys.request(job.id));
  if (prev && prev.version > job.version) return false;
  qc.setQueryData(queryKeys.request(job.id), job);
  return prev?.status !== 'ASSIGNED' && job.status === 'ASSIGNED';
}

/**
 * Ciclo de vida del trabajo adjudicado, sin polling: `job:updated` (cada transición, DTO
 * serializado para este proveedor) y `booking:assigned` (Escrow retenido, dirección
 * desbloqueada). Se monta una vez en el layout para no perder eventos fuera de la ficha.
 */
export function useJobEvents() {
  const qc = useQueryClient();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    // Pago confirmado: vibración y, si el profesional está en otra pantalla, se le lleva a la ficha.
    const announce = (job: ServiceRequest) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (pathnameRef.current !== `/job/${job.id}`) {
        router.push({ pathname: '/job/[id]', params: { id: job.id } });
      }
    };

    const onUpdated: OffersServerEvents['job:updated'] = ({ job }) => {
      if (storeJob(qc, job)) announce(job);
    };
    const onAssigned: OffersServerEvents['booking:assigned'] = ({ job, guaranteedPayoutEur }) => {
      qc.setQueryData(payoutKey(job.id), guaranteedPayoutEur);
      if (storeJob(qc, job)) announce(job);
    };

    offersSocket.on('job:updated', onUpdated);
    offersSocket.on('booking:assigned', onAssigned);
    return () => {
      offersSocket.off('job:updated', onUpdated);
      offersSocket.off('booking:assigned', onAssigned);
    };
  }, [qc]);
}
