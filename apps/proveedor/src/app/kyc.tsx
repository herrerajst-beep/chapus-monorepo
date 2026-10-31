import { useState } from 'react';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useApi, useMe } from '@chapus/api';
import { Badge, Button, Card, Screen, Text, palette } from '@chapus/ui';
import { resumeAfterKyc } from '@/features/presence/usePresence';

const KYC_LABEL = {
  UNVERIFIED: 'Sin verificar',
  PENDING_VERIFICATION: 'En revisión por Stripe',
  VERIFIED: 'Verificado',
  RESTRICTED: 'Restringido: revisa tus datos',
} as const;

export default function KycScreen() {
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const start = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const returnUrl = Linking.createURL('stripe-kyc/return');
      const refreshUrl = Linking.createURL('stripe-kyc/refresh');
      const { onboardingUrl } = await api.startStripeOnboarding(returnUrl, refreshUrl);
      // SFSafariViewController / Custom Tabs: Stripe nunca corre dentro de nuestra WebView.
      const result = await WebBrowser.openAuthSessionAsync(onboardingUrl, returnUrl);
      // Stripe actualiza el KYC por webhook: renovamos el JWT (claim kycStatus) y el perfil.
      await resumeAfterKyc();
      await qc.invalidateQueries({ queryKey: queryKeys.me });
      if (result.type === 'success' && result.url.includes('refresh')) await start();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const status = me.data?.kycStatus ?? 'UNVERIFIED';

  return (
    <Screen>
      <Card>
        <Badge tone={status === 'VERIFIED' ? 'brand' : 'provider'} label={KYC_LABEL[status]} />
        <Text variant="heading">Cobra tus trabajos con Stripe</Text>
        <Text muted>
          Para recibir pagos necesitas verificar tu DNI/NIE y una cuenta IBAN. Chapus no almacena estos datos:
          los gestiona Stripe de forma segura.
        </Text>
      </Card>
      {failed ? <Text style={{ color: palette.danger }}>No se pudo abrir Stripe. Inténtalo de nuevo.</Text> : null}
      {status === 'VERIFIED' ? (
        <Button tone="provider" label="Volver al radar" onPress={() => router.back()} />
      ) : (
        <Button tone="provider" label={status === 'UNVERIFIED' ? 'Empezar verificación' : 'Continuar verificación'} loading={busy} onPress={start} />
      )}
    </Screen>
  );
}
