import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useBids, useRequest } from '@chapus/api';
import type { Bid, BookingsServerEvents } from '@chapus/core';
import { bookingsSocket } from '@/lib/api';

/**
 * Estado en vivo de una solicitud: carga inicial por REST (GET /requests/{id} y /bids)
 * y actualizaciones por el namespace /bookings, suscrito a la sala `request:{id}`.
 * La suscripción se repite en cada reconexión, porque el servidor olvida las salas.
 */
export function useRequestLive(requestId: string) {
  const qc = useQueryClient();
  const request = useRequest(requestId);
  const isBidding = request.data?.pricingModel === 'BIDDING';
  const bids = useBids(requestId, isBidding);

  useEffect(() => {
    const subscribe = () => {
      bookingsSocket.emit('request:subscribe', requestId, () => {
        // Al (re)suscribirse pueden haberse perdido eventos: rehidratamos desde REST.
        void qc.invalidateQueries({ queryKey: queryKeys.request(requestId) });
      });
    };

    // job:updated llega con el DTO del propietario (dirección siempre visible).
    const onUpdated: BookingsServerEvents['job:updated'] = ({ job: r }) => {
      if (r.id !== requestId) return;
      // Descarta eventos fuera de orden: `version` crece con cada cambio de estado.
      qc.setQueryData(queryKeys.request(requestId), (prev: typeof r | undefined) =>
        prev && prev.version > r.version ? prev : r,
      );
    };
    const onBid: BookingsServerEvents['request:bid_created'] = ({ requestId: rid, bid }) => {
      if (rid !== requestId) return;
      qc.setQueryData<Bid[]>(queryKeys.bids(requestId), (prev = []) =>
        prev.some((b) => b.id === bid.id) ? prev : [bid, ...prev],
      );
    };

    bookingsSocket.on('connect', subscribe);
    bookingsSocket.on('job:updated', onUpdated);
    bookingsSocket.on('request:bid_created', onBid);
    if (bookingsSocket.connected) subscribe();
    else bookingsSocket.connect();

    return () => {
      bookingsSocket.off('connect', subscribe);
      bookingsSocket.off('job:updated', onUpdated);
      bookingsSocket.off('request:bid_created', onBid);
    };
  }, [qc, requestId]);

  const pending = (bids.data ?? []).filter((b) => b.status === 'PENDING').sort((a, b) => a.amountEur - b.amountEur);
  return { request: request.data, isLoading: request.isLoading, isError: request.isError, bids: pending };
}
