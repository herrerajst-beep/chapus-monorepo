import { useState } from 'react';
import { View } from 'react-native';
import { useApi } from '@chapus/api';
import type { NearbyRequest } from '@chapus/core';
import { Badge, Button, Card, Screen, Text, palette, space } from '@chapus/ui';
import { isDemoSession, offersSocket, useSession } from '@/lib/api';
import { handleJobAlert } from '@/features/alerts/useJobAlertChannel';
import { useAlerts } from '@/features/alerts/store';
import { summarize, useLatency } from '@/features/diagnostics/latency';
import { usePresenceStore } from '@/features/presence/usePresence';

const LOST_AFTER_MS = 2_500;

const fmt = (ms: number | null) => (ms === null ? '—' : `${ms} ms`);

function Row({ label, values }: { label: string; values: (number | null)[] }) {
  const s = summarize(values);
  return (
    <View style={{ gap: 2 }}>
      <Text variant="caption" muted>{label} (n={s.n})</Text>
      <Text>p50 {fmt(s.p50)} · p95 {fmt(s.p95)} · máx {fmt(s.max)}</Text>
    </View>
  );
}

/** Auditoría en dispositivo físico: latencia de alertas, render del banner y RTT de red. */
export default function DiagnosticsScreen() {
  const api = useApi();
  const samples = useLatency((s) => s.samples);
  const clear = useLatency((s) => s.clear);
  const { streaming, online, heartbeatError } = usePresenceStore();
  const demo = useSession(() => isDemoSession());
  const [rtt, setRtt] = useState<number[]>([]);
  const [measuring, setMeasuring] = useState(false);

  const transport = offersSocket.io.engine?.transport?.name ?? '—';

  const measureRtt = async () => {
    setMeasuring(true);
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await api.categories().catch(() => undefined);
      out.push(Math.round(performance.now() - t));
    }
    setRtt(out);
    setMeasuring(false);
  };

  const simulate = () => {
    const now = new Date().toISOString();
    const fake: NearbyRequest = {
      id: `sim-${Date.now()}`,
      clientId: 'sim',
      categoryId: 101,
      pricingModel: 'FAST_MATCH',
      offeredPriceEur: 65,
      location: { lat: 40.42, lng: -3.7 },
      addressText: null,
      approximateZone: '28013 Madrid',
      isAddressMasked: true,
      description: 'Alerta simulada desde Diagnóstico',
      photoUrls: [],
      scheduledAt: null,
      assignedProviderId: null,
      finalAgreedPriceEur: null,
      status: 'OPEN',
      bidsCount: 0,
      version: 1,
      createdAt: now,
      acceptedAt: null,
      completedAt: null,
      distanceKm: 1.2,
    };
    handleJobAlert({ request: fake, distanceKm: fake.distanceKm }, () => undefined, 'simulated');
    return fake.id;
  };

  /** Escenario 1 de la auditoría: geo:job_taken llega mientras el banner está a la vista. */
  const simulateLost = () => {
    const id = simulate();
    setTimeout(() => useAlerts.getState().markTaken(id), LOST_AFTER_MS);
  };

  const ws = samples.filter((s) => s.source === 'ws');

  return (
    <Screen>
      <Card>
        <Text variant="heading">Conexión</Text>
        <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
          <Badge tone={online ? 'provider' : 'neutral'} label={online ? 'Disponible' : 'No disponible'} />
          {demo ? (
            <Badge label="modo demo: sin socket" />
          ) : (
            <>
              <Badge tone={streaming ? 'brand' : 'danger'} label={streaming ? '/offers conectado' : '/offers desconectado'} />
              <Badge label={`transporte: ${transport}`} />
            </>
          )}
        </View>
        {heartbeatError ? (
          <Text variant="caption" style={{ color: palette.danger }}>Último heartbeat fallido: {heartbeatError}</Text>
        ) : null}
      </Card>

      <Card>
        <Text variant="heading">Alertas Fast-Match</Text>
        <Row label="Servidor → móvil (WS reales, incluye desfase de reloj)" values={ws.map((s) => s.serverToDeviceMs)} />
        <Row label="Evento → ACK enviado" values={samples.map((s) => s.ackMs)} />
        <Row label="Evento → banner naranja pintado (objetivo < 150 ms)" values={samples.map((s) => s.renderMs)} />
        <Button tone="provider" label="Simular alerta Fast-Match" onPress={simulate} />
        <Button
          tone="provider"
          variant="outline"
          label={`Simular alerta perdida (job_taken a los ${LOST_AFTER_MS / 1_000} s)`}
          onPress={simulateLost}
        />
        <Text variant="caption" muted>
          En modo demo, «Aceptar» responde 409, como cuando otro profesional gana la carrera.
        </Text>
        <Button tone="neutral" variant="outline" label="Borrar muestras" onPress={clear} />
      </Card>

      <Card>
        <Text variant="heading">Red (RTT HTTP al API)</Text>
        <Text variant="caption" muted>5 peticiones a /catalog/categories. Útil para comparar Wi-Fi, 4G y 5G.</Text>
        {rtt.length ? <Text>{rtt.join(' · ')} ms</Text> : null}
        <Button tone="provider" variant="outline" label="Medir" loading={measuring} onPress={() => void measureRtt()} />
      </Card>

      <Text variant="caption" muted>
        La latencia emit→ACK exacta la mide el backend comparando su hora de emisión con el `timestamp` del ACK.
      </Text>
    </Screen>
  );
}
