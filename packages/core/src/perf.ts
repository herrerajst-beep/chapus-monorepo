/** Percentil p (0-100) por el método nearest-rank. Devuelve null sin muestras. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

/**
 * Detecta bloqueos del hilo JS: un temporizador de 16 ms que llega tarde indica que el
 * hilo estuvo ocupado. Se usa para auditar que el PaymentSheet (nativo) no congela la UI.
 */
export function createStallMonitor(intervalMs = 16) {
  let last = Date.now();
  let maxStallMs = 0;
  let stalls = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - intervalMs;
    if (lag > 50) stalls += 1; // >50 ms ≈ 3 frames perdidos a 60 Hz
    if (lag > maxStallMs) maxStallMs = lag;
    last = now;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return { maxStallMs: Math.max(0, maxStallMs), stalls };
    },
  };
}
