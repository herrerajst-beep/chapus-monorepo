import { ActivityIndicator, Linking, Platform, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useCategories, useJobLifecycle } from '@chapus/api';
import { STATUS_LABEL, displayPrice, formatEur, navigationLinks } from '@chapus/core';
import { Badge, Button, Card, Screen, Text, palette, space } from '@chapus/ui';
import { useAssignedJob } from '@/features/jobs/useAssignedJob';

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: job, isError, refetch, guaranteedPayoutEur } = useAssignedJob(id);
  const categories = useCategories();
  const { start } = useJobLifecycle(id);

  if (isError) {
    return (
      <Screen>
        <Text>No pudimos cargar el trabajo.</Text>
        <Button tone="provider" variant="outline" label="Reintentar" onPress={() => void refetch()} />
      </Screen>
    );
  }
  if (!job) return <Screen><Text muted>Cargando trabajo…</Text></Screen>;

  const price = displayPrice(job);
  // El servidor decide la máscara (ServiceRequestSerializer): sin dirección no hay ruta.
  const revealed = !job.isAddressMasked && job.addressText !== null;
  const links = navigationLinks(job.location);
  const category = categories.data?.find((c) => c.id === job.categoryId)?.name;

  return (
    <Screen>
      <Card>
        <Badge tone="provider" label={STATUS_LABEL[job.status]} />
        {category ? <Text variant="heading">{category}</Text> : null}
        {price !== null ? <Text variant="title">{formatEur(price)}</Text> : null}
        <Text>{job.description}</Text>
      </Card>

      {job.status === 'AWAITING_PAYMENT' ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <ActivityIndicator color={palette.provider} />
            <View style={{ flex: 1, gap: space.xs }}>
              <Text variant="heading">Esperando la confirmación del pago</Text>
              <Text variant="caption" muted>
                Zona: {job.approximateZone}. Verás la dirección exacta y la ruta en cuanto el
                cliente pague. El importe queda protegido por Stripe.
              </Text>
            </View>
          </View>
        </Card>
      ) : null}

      {revealed ? (
        <Card style={{ borderColor: palette.provider, borderWidth: 1.5 }}>
          {job.status === 'ASSIGNED' ? <Badge tone="provider" label="✓ Pago confirmado" /> : null}
          {guaranteedPayoutEur !== null ? (
            <Text>Cobro garantizado: <Text variant="heading">{formatEur(guaranteedPayoutEur)}</Text></Text>
          ) : null}
          <Text variant="caption" muted>Dirección del cliente</Text>
          <Text variant="heading" selectable>{job.addressText}</Text>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button tone="provider" label="Google Maps" onPress={() => void Linking.openURL(links.googleMaps)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button tone="provider" variant="outline" label="Waze" onPress={() => void Linking.openURL(links.waze)} />
            </View>
          </View>
          {Platform.OS === 'ios' ? (
            <Button tone="neutral" variant="outline" label="Mapas de Apple" onPress={() => void Linking.openURL(links.appleMaps)} />
          ) : null}
        </Card>
      ) : null}

      {job.status === 'ASSIGNED' ? (
        <Button tone="provider" label="He llegado: iniciar trabajo" loading={start.isPending} onPress={() => start.mutate()} />
      ) : null}
      {start.isError ? (
        <Text style={{ color: palette.danger }}>No se pudo iniciar. Comprueba que estás en el domicilio.</Text>
      ) : null}
      {job.status === 'IN_PROGRESS' ? (
        <Text muted>Trabajo en curso. El cliente confirmará la finalización y recibirás el pago en tu cuenta.</Text>
      ) : null}
    </Screen>
  );
}
