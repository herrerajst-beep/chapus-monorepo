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
  /** Otro profesional ganó la carrera (geo:job_taken, 409 o 403 RGPD). */
  takenAt?: number;
}

/** Tiempo que la alerta perdida sigue visible (mensaje + fundido) antes de retirarse. */
export const TAKEN_LINGER_MS = 1_800;

interface AlertsState {
  alerts: JobAlert[];
  /** Ids ya vistos: un ACK tardío puede hacer que llegue también el push. */
  seen: Set<string>;
  receive: (alert: JobAlert) => boolean;
  /** Transición suave: marca la alerta como tomada y la retira tras TAKEN_LINGER_MS. */
  markTaken: (requestId: string) => void;
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
  markTaken: (requestId) => {
    const target = get().alerts.find((a) => a.requestId === requestId);
    if (!target || target.takenAt) return;
    set({ alerts: get().alerts.map((a) => (a.requestId === requestId ? { ...a, takenAt: Date.now() } : a)) });
    setTimeout(() => get().dismiss(requestId), TAKEN_LINGER_MS);
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
