import { Linking } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useJobLifecycle, useRequest } from '@chapus/api';
import { STATUS_LABEL, displayPrice, formatEur } from '@chapus/core';
import { Badge, Button, Card, Screen, Text, palette } from '@chapus/ui';

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: job } = useRequest(id);
  const { start } = useJobLifecycle(id);

  if (!job) return <Screen><Text muted>Cargando trabajo…</Text></Screen>;
  const price = displayPrice(job);

  const openMaps = () =>
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${job.location.lat},${job.location.lng}`);

  return (
    <Screen>
      <Card>
        <Badge tone="provider" label={STATUS_LABEL[job.status]} />
        {price !== null ? <Text variant="title">{formatEur(price)}</Text> : null}
        <Text>{job.description}</Text>
        <Text variant="caption" muted>{job.addressText}</Text>
      </Card>
      {job.status === 'AWAITING_PAYMENT' ? (
        <Text muted>Esperando a que el cliente confirme el pago. Te avisaremos al instante.</Text>
      ) : null}
      <Button tone="provider" variant="outline" label="Cómo llegar" onPress={openMaps} />
      {job.status === 'ASSIGNED' ? (
        <Button tone="provider" label="He llegado: iniciar trabajo" loading={start.isPending} onPress={() => start.mutate()} />
      ) : null}
      {start.isError ? <Text style={{ color: palette.danger }}>No se pudo iniciar. Comprueba que estás en el domicilio.</Text> : null}
    </Screen>
  );
}
