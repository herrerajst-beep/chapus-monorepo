import { create } from 'zustand';
import { percentile } from '@chapus/core';

/** Panel de diagnóstico: en desarrollo o con EXPO_PUBLIC_DIAGNOSTICS=1 (perfil staging). */
export const DIAGNOSTICS_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_DIAGNOSTICS === '1';

const MAX_SAMPLES = 50;

export interface AlertSample {
  requestId: string;
  source: 'ws' | 'push' | 'simulated';
  /** createdAt del servidor → recepción en el móvil. Incluye desfase de relojes (±1 s típico). */
  serverToDeviceMs: number | null;
  /** Recepción del evento → ACK enviado (debe ser ~0: el ACK va antes de cualquier trabajo). */
  ackMs: number;
  /** Recepción del evento → primer layout del banner naranja. Objetivo < 150 ms. */
  renderMs: number | null;
  /** performance.now() al recibir; sirve para cerrar renderMs. */
  t0: number;
}

interface LatencyState {
  samples: AlertSample[];
  record: (s: Omit<AlertSample, 'renderMs'>) => void;
  markRendered: (requestId: string) => void;
  clear: () => void;
}

export const useLatency = create<LatencyState>((set, get) => ({
  samples: [],
  record: (s) => {
    if (!DIAGNOSTICS_ENABLED) return;
    set({ samples: [{ ...s, renderMs: null }, ...get().samples].slice(0, MAX_SAMPLES) });
  },
  markRendered: (requestId) => {
    if (!DIAGNOSTICS_ENABLED) return;
    const now = performance.now();
    set({
      samples: get().samples.map((s) =>
        s.requestId === requestId && s.renderMs === null ? { ...s, renderMs: Math.round(now - s.t0) } : s,
      ),
    });
  },
  clear: () => set({ samples: [] }),
}));

export function summarize(values: (number | null)[]) {
  const v = values.filter((x): x is number => x !== null);
  return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: v.length ? Math.max(...v) : null };
}
