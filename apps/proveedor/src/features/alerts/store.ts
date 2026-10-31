import { create } from 'zustand';
import { FAST_MATCH_ALERT_TTL_MS, isAlertExpired, type NearbyRequest, type PricingModel } from '@chapus/core';

/**
 * Una alerta puede llegar completa (WebSocket) o parcial (push de respaldo, que solo
 * trae requestId/precio). La parcial se completa al abrirla.
 */
export interface JobAlert {
  requestId: string;
  pricingModel: PricingModel;
  offeredPriceEur?: number | null;
  /** Del push de respaldo: única referencia de ubicación hasta tener el DTO. */
  approximateZone?: string;
  receivedAt: number;
  source: 'ws' | 'push';
  request?: NearbyRequest;
}

interface AlertsState {
  alerts: JobAlert[];
  /** Ids ya vistos: un ACK tardío puede hacer que llegue también el push. */
  seen: Set<string>;
  receive: (alert: JobAlert) => boolean;
  dismiss: (requestId: string) => void;
  prune: () => void;
}

export const useAlerts = create<AlertsState>((set, get) => ({
  alerts: [],
  seen: new Set(),
  receive: (alert) => {
    const { seen, alerts } = get();
    if (alert.request && isAlertExpired(alert.request)) return false;
    if (seen.has(alert.requestId)) {
      // Si ya teníamos la versión parcial del push, la enriquecemos con la del socket.
      if (alert.request) {
        set({ alerts: alerts.map((a) => (a.requestId === alert.requestId ? { ...a, ...alert } : a)) });
      }
      return false;
    }
    set({ seen: new Set(seen).add(alert.requestId), alerts: [alert, ...alerts] });
    return true;
  },
  dismiss: (requestId) => set({ alerts: get().alerts.filter((a) => a.requestId !== requestId) }),
  prune: () => {
    const now = Date.now();
    set({
      alerts: get().alerts.filter((a) =>
        a.pricingModel !== 'FAST_MATCH' ? true : now - a.receivedAt < FAST_MATCH_ALERT_TTL_MS,
      ),
    });
  },
}));
