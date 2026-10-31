import { useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { isApiError, useCreateBid, useFastAccept, useMe } from '@chapus/api';
import { bidSchema, fieldErrors, formatDistance, isAlertExpired } from '@chapus/core';
import { Badge, Button, Card, Field, Price, Screen, Text, palette, space } from '@chapus/ui';
import { useAlerts } from '@/features/alerts/store';
import { useAlertRequest } from '@/features/alerts/useAlertRequest';

export default function AlertScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useMe();
  const dismiss = useAlerts((s) => s.dismiss);
  const { request, isLoading } = useAlertRequest(id);

  const fastAccept = useFastAccept();
  const [outcome, setOutcome] = useState<'TAKEN' | 'KYC' | 'ERROR' | null>(null);

  if (isLoading) return <Screen><Text muted>Cargando trabajo…</Text></Screen>;
  if (!request) {
    return (
      <Screen>
        <Text variant="heading">Este trabajo ya no está disponible</Text>
        <Button tone="provider" variant="outline" label="Volver" onPress={() => router.back()} />
      </Screen>
    );
  }

  const expired = isAlertExpired(request);
  const isFast = request.pricingModel === 'FAST_MATCH';
  const needsKyc = outcome === 'KYC' || (me.data !== undefined && me.data.kycStatus !== 'VERIFIED');

  const accept = () =>
    fastAccept.mutate(request.id, {
      onSuccess: () => {
        dismiss(request.id);
        router.replace({ pathname: '/job/[id]', params: { id: request.id } });
      },
      onError: (e) => {
        if (isApiError(e, 409)) {
          setOutcome('TAKEN');
          dismiss(request.id);
        } else if (isApiError(e, 403)) setOutcome('KYC');
        else setOutcome('ERROR');
      },
    });

  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Badge tone="provider" label={isFast ? '⚡ Tarifa fija' : '📋 Pide presupuesto'} />
          {request.distanceKm !== undefined ? <Text variant="caption" muted>{formatDistance(request.distanceKm)}</Text> : null}
        </View>
        {isFast && request.offeredPriceEur ? <Price tone="provider" amount={request.offeredPriceEur} /> : null}
        <Text>{request.description}</Text>
        <Text variant="caption" muted>{request.addressText}</Text>
        <Text variant="caption" muted>
          {request.scheduledAt ? `Programado: ${new Date(request.scheduledAt).toLocaleString('es-ES')}` : 'Urgente: lo antes posible'}
        </Text>
        {request.photoUrls?.length ? (
          <ScrollView horizontal contentContainerStyle={{ gap: space.sm }}>
            {request.photoUrls.map((uri) => (
              <Image key={uri} source={{ uri }} style={{ width: 120, height: 120, borderRadius: 8 }} />
            ))}
          </ScrollView>
        ) : null}
      </Card>

      {outcome === 'TAKEN' ? <Text style={{ color: palette.danger }}>Otro profesional lo aceptó antes que tú.</Text> : null}
      {needsKyc ? (
        <Card style={{ borderColor: palette.provider }}>
          <Text>Tu identidad aún no está verificada en Stripe.</Text>
          <Button tone="provider" label="Completar verificación" onPress={() => router.push('/kyc')} />
        </Card>
      ) : null}
      {outcome === 'ERROR' ? <Text style={{ color: palette.danger }}>No se pudo aceptar. Inténtalo de nuevo.</Text> : null}

      {isFast ? (
        <Button
          tone="provider"
          label={expired ? 'Oferta caducada' : 'Aceptar trabajo'}
          loading={fastAccept.isPending}
          disabled={expired || outcome === 'TAKEN' || needsKyc}
          onPress={accept}
        />
      ) : (
        <BidForm requestId={request.id} onSent={() => { dismiss(request.id); router.back(); }} />
      )}
    </Screen>
  );
}

function BidForm({ requestId, onSent }: { requestId: string; onSent: () => void }) {
  const createBid = useCreateBid(requestId);
  const [amount, setAmount] = useState('');
  const [eta, setEta] = useState('45');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const parsed = bidSchema.safeParse({
      amountEur: Number(amount.replace(',', '.')),
      estimatedArrivalMinutes: Number(eta),
      notes: notes || undefined,
    });
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    createBid.mutate(parsed.data, {
      onSuccess: onSent,
      onError: () => setErrors({ form: 'No se pudo enviar el presupuesto.' }),
    });
  };

  return (
    <Card>
      <Text variant="heading">Tu presupuesto</Text>
      <Field label="Importe total (IVA incl.) €" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} error={errors.amountEur} />
      <Field label="Llegada estimada (minutos)" keyboardType="number-pad" value={eta} onChangeText={setEta} error={errors.estimatedArrivalMinutes} />
      <Field label="Notas para el cliente" multiline value={notes} onChangeText={setNotes} error={errors.notes} placeholder="Incluye desplazamiento y materiales…" />
      {errors.form ? <Text style={{ color: palette.danger }}>{errors.form}</Text> : null}
      <Button tone="provider" label="Enviar presupuesto" loading={createBid.isPending} onPress={submit} />
    </Card>
  );
}
