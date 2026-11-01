import { isApiError } from '@chapus/api';
import { Button, OtpLoginForm, Text } from '@chapus/ui';
import { api, session, signInDemo } from '@/lib/api';
import { getNativePushToken } from '@/features/alerts/notifications';
import { DEMO_ENABLED } from '@/features/demo/demoApi';

const describeError = (e: unknown, step: 'request' | 'verify') => {
  if (isApiError(e, 429)) return 'Demasiados intentos. Espera un minuto.';
  if (step === 'verify' && isApiError(e, 401)) return 'Código incorrecto o caducado.';
  return isApiError(e) ? e.message : 'Sin conexión. Inténtalo de nuevo.';
};

export default function LoginScreen() {
  return (
    <OtpLoginForm
      tone="provider"
      title="Chapus Pro"
      subtitle="Recibe trabajos cerca de ti y cobra protegido por Stripe."
      describeError={describeError}
      onRequestCode={(phone, channel) => api.requestOtp(phone, channel)}
      onVerify={async (phone, code) => {
        const fcmToken = await getNativePushToken().catch(() => null);
        await session.signIn(await api.verifyOtp(phone, code, 'PROVIDER', fcmToken));
      }}
      footer={
        DEMO_ENABLED ? (
          <>
            <Button tone="neutral" variant="outline" label="Entrar en modo demo" onPress={() => void signInDemo()} />
            <Text variant="caption" muted>
              Solo desarrollo: sin backend, con datos y alertas simuladas.
            </Text>
          </>
        ) : null
      }
    />
  );
}
