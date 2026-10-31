import { isApiError } from '@chapus/api';
import { OtpLoginForm } from '@chapus/ui';
import { api, session } from '@/lib/api';

const describeError = (e: unknown, step: 'request' | 'verify') => {
  if (isApiError(e, 429)) return 'Demasiados intentos. Espera un minuto.';
  if (step === 'verify' && isApiError(e, 401)) return 'Código incorrecto o caducado.';
  return isApiError(e) ? e.message : 'Sin conexión. Inténtalo de nuevo.';
};

export default function LoginScreen() {
  return (
    <OtpLoginForm
      title="Bienvenido a Chapus"
      subtitle="Entra con tu móvil. Sin contraseñas."
      describeError={describeError}
      onRequestCode={(phone, channel) => api.requestOtp(phone, channel)}
      onVerify={async (phone, code) => {
        await session.signIn(await api.verifyOtp(phone, code, 'CLIENT'));
      }}
    />
  );
}
