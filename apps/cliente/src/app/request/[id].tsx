import { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAcceptBid, useJobLifecycle } from '@chapus/api';
import { STATUS_LABEL, displayPrice, formatEur, type Bid } from '@chapus/core';
import { Badge, Button, Card, Screen, Text, palette, space } from '@chapus/ui';
import { payWithSheet } from '@/lib/payments';
import { useRequestLive } from '@/features/request/useRequestLive';

export default function RequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { request, isLoading, isError, bids } = useRequestLive(id);
  const acceptBid = useAcceptBid(id);
  const { complete } = useJobLifecycle(id);
  const [payError, setPayError] = useState<string | null>(null);

  if (isLoading) return <Screen><Text muted>Cargando solicitud…</Text></Screen>;
  if (isError || !request) return <Screen><Text>No encontramos esta solicitud.</Text></Screen>;

  const accept = async (bid: Bid) => {
    setPayError(null);
    try {
      const { paymentSheet } = await acceptBid.mutateAsync(bid.id);
      if (!paymentSheet) throw new Error('paymentSheet ausente');
      const paid = await payWithSheet(paymentSheet);
      if (paid.status === 'failed') setPayError(paid.message);
    } catch {
      setPayError('No se pudo reservar este presupuesto. Inténtalo de nuevo.');
    }
  };

  const price = displayPrice(request);

  return (
    <Screen>
      <Card>
        <Badge tone="brand" label={STATUS_LABEL[request.status]} />
        {price !== null ? <Text variant="title">{formatEur(price)}</Text> : null}
        <Text>{request.description}</Text>
        <Text variant="caption" muted>{request.addressText ?? request.approximateZone}</Text>
      </Card>

      {request.status === 'OPEN' && request.pricingModel === 'FAST_MATCH' ? (
        <Text muted>Avisando a los profesionales más cercanos. Normalmente alguien acepta en menos de 2 minutos.</Text>
      ) : null}

      {request.status === 'OPEN' && request.pricingModel === 'BIDDING' ? (
        <View style={{ gap: space.sm }}>
          <Text variant="heading">Presupuestos recibidos ({bids.length})</Text>
          {bids.length === 0 ? <Text muted>Te avisaremos en cuanto llegue el primero.</Text> : null}
          {bids.map((bid) => (
            <Card key={bid.id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="heading">{bid.provider.fullName}</Text>
                <Text variant="caption" muted>
                  ★ {bid.provider.ratingAvg.toFixed(1)} · {bid.provider.completedJobsCount} trabajos
                </Text>
              </View>
              <Text variant="title">{formatEur(bid.amountEur)}</Text>
              <Text variant="caption" muted>Llega en ~{bid.estimatedArrivalMinutes} min</Text>
              {bid.notes ? <Text>{bid.notes}</Text> : null}
              <Button label="Aceptar y pagar" loading={acceptBid.isPending && acceptBid.variables === bid.id} disabled={acceptBid.isPending} onPress={() => void accept(bid)} />
            </Card>
          ))}
        </View>
      ) : null}

      {request.status === 'AWAITING_PAYMENT' ? (
        <Text muted>Estamos confirmando tu pago con el banco…</Text>
      ) : null}
      {request.status === 'ASSIGNED' ? <Text>Tu profesional está en camino. El pago queda protegido hasta que confirmes el trabajo.</Text> : null}
      {request.status === 'IN_PROGRESS' ? (
        <Button label="Confirmar trabajo terminado" loading={complete.isPending} onPress={() => complete.mutate()} />
      ) : null}
      {request.status === 'COMPLETED' ? (
        <Button variant="outline" label="Volver al inicio" onPress={() => router.replace('/')} />
      ) : null}

      {payError ? <Text style={{ color: palette.danger }}>{payError}</Text> : null}
    </Screen>
  );
}
