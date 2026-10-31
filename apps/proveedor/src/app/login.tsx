import { isApiError } from '@chapus/api';
import { OtpLoginForm } from '@chapus/ui';
import { api, session } from '@/lib/api';
import { getNativePushToken } from '@/features/alerts/notifications';

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
    />
  );
}
