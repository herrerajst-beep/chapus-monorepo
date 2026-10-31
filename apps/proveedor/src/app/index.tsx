import { Switch, View } from 'react-native';
import { router } from 'expo-router';
import { useCategories, useMe, useNearbyRequests } from '@chapus/api';
import { formatDistance, formatEur } from '@chapus/core';
import { Badge, Button, Card, Screen, Text, palette, space } from '@chapus/ui';
import { goOffline, goOnline, usePresenceStore } from '@/features/presence/usePresence';
import { useAlerts } from '@/features/alerts/store';

export default function RadarScreen() {
  const me = useMe();
  const categories = useCategories();
  const { online, streaming, position, error } = usePresenceStore();
  const radius = me.data?.serviceRadiusKm ?? 10;
  const nearby = useNearbyRequests(position, radius, online);
  const alerts = useAlerts((s) => s.alerts);
  const needsKyc = error === 'KYC_REQUIRED' || (me.data !== undefined && me.data.kycStatus !== 'VERIFIED');
  const categoryName = (id: number) => categories.data?.find((c) => c.id === id)?.name ?? 'Nuevo trabajo';

  return (
    <Screen>
      {needsKyc ? (
        <Card style={{ borderColor: palette.provider }}>
          <Text variant="heading">Verifica tu identidad para recibir ofertas</Text>
          <Text muted>
            Hasta que Stripe valide tu DNI/NIE e IBAN no te llegarán trabajos en directo ni podrás aceptarlos.
          </Text>
          <Button tone="provider" label="Verificar con Stripe" onPress={() => router.push('/kyc')} />
        </Card>
      ) : null}

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ gap: space.xs, flex: 1 }}>
            <Text variant="heading">{online ? 'Disponible' : 'No disponible'}</Text>
            <Text variant="caption" muted>
              {!online
                ? 'Actívate para recibir trabajos cercanos'
                : streaming
                  ? `Ofertas en directo en ${radius} km`
                  : 'Conectando con el radar…'}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Disponibilidad"
            value={online}
            onValueChange={(v) => void (v ? goOnline() : goOffline())}
            trackColor={{ true: palette.provider, false: palette.line }}
          />
        </View>
        {error === 'LOCATION_DENIED' ? (
          <Text variant="caption" style={{ color: palette.danger }}>
            Necesitamos tu ubicación para enviarte trabajos. Actívala en Ajustes.
          </Text>
        ) : null}
        {error === 'HEARTBEAT_FAILED' ? (
          <Text variant="caption" style={{ color: palette.danger }}>Sin conexión con Chapus. Reintentando…</Text>
        ) : null}
      </Card>

      {alerts.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Text variant="heading">Avisos nuevos</Text>
          {alerts.map((a) => (
            <Card
              key={a.requestId}
              style={{ borderColor: palette.provider, borderWidth: 1.5 }}
              onPress={() => router.push({ pathname: '/alert/[id]', params: { id: a.requestId } })}
            >
              <Badge tone="provider" label={a.pricingModel === 'FAST_MATCH' ? '⚡ Trabajo directo' : '📋 Presupuesto'} />
              <Text variant="heading">{a.request ? categoryName(a.request.categoryId) : 'Nuevo trabajo cerca'}</Text>
              {a.offeredPriceEur ? <Text>{formatEur(a.offeredPriceEur)}</Text> : null}
            </Card>
          ))}
        </View>
      ) : null}

      {online ? (
        <View style={{ gap: space.sm }}>
          <Text variant="heading">Solicitudes abiertas cerca</Text>
          {nearby.isLoading ? <Text muted>Buscando…</Text> : null}
          {nearby.data?.length === 0 ? <Text muted>No hay solicitudes abiertas ahora mismo.</Text> : null}
          {nearby.data?.map((r) => (
            <Card key={r.id} onPress={() => router.push({ pathname: '/alert/[id]', params: { id: r.id } })}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Badge
                  tone={r.pricingModel === 'FAST_MATCH' ? 'provider' : 'neutral'}
                  label={r.pricingModel === 'FAST_MATCH' ? 'Tarifa fija' : `Presupuesto · ${r.bidsCount} ofertas`}
                />
                <Text variant="caption" muted>{formatDistance(r.distanceKm)}</Text>
              </View>
              <Text variant="heading">{categoryName(r.categoryId)}</Text>
              <Text numberOfLines={2}>{r.description}</Text>
              {r.offeredPriceEur ? <Text variant="heading">{formatEur(r.offeredPriceEur)}</Text> : null}
            </Card>
          ))}
        </View>
      ) : null}
    </Screen>
  );
}
