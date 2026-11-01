import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { normalizeSpanishPhone, otpCodeSchema, type OtpChannel } from '@chapus/core';
import { Button, Field, Screen, Segmented, Text } from './components';
import { palette, space, type Tone } from './theme';

const RESEND_SECONDS = 30;

interface Props {
  title: string;
  subtitle: string;
  tone?: Tone;
  onRequestCode: (phone: string, channel: OtpChannel) => Promise<void>;
  onVerify: (phone: string, code: string) => Promise<void>;
  /** Traduce errores del backend (p. ej. ApiError 401/429) a texto para el usuario. */
  describeError: (e: unknown, step: 'request' | 'verify') => string;
  /** Contenido extra bajo el formulario (p. ej. el acceso al modo demo en desarrollo). */
  footer?: ReactNode;
}

/** Login passwordless en dos pasos: teléfono (+34) → código de 6 dígitos. */
export function OtpLoginForm({
  title,
  subtitle,
  tone = 'brand',
  onRequestCode,
  onVerify,
  describeError,
  footer,
}: Props) {
  const [phoneInput, setPhoneInput] = useState('');
  const [channel, setChannel] = useState<OtpChannel>('WHATSAPP');
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1_000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const request = async () => {
    const e164 = normalizeSpanishPhone(phoneInput);
    if (!e164) return setError('Introduce un móvil español válido (6xx, 7xx…).');
    setError(null);
    setBusy(true);
    try {
      await onRequestCode(e164, channel);
      setPhone(e164);
      setCode('');
      setResendIn(RESEND_SECONDS);
    } catch (e) {
      setError(describeError(e, 'request'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value = code) => {
    if (!phone) return;
    const parsed = otpCodeSchema.safeParse(value);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Código no válido');
    setError(null);
    setBusy(true);
    try {
      await onVerify(phone, parsed.data);
    } catch (e) {
      setError(describeError(e, 'verify'));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ gap: space.xs, marginTop: space.xxl }}>
        <Text variant="title">{title}</Text>
        <Text muted>{subtitle}</Text>
      </View>

      {!phone ? (
        <>
          <Field
            label="Móvil"
            placeholder="600 11 22 33"
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            value={phoneInput}
            onChangeText={setPhoneInput}
          />
          <Segmented
            value={channel}
            onChange={setChannel}
            options={[
              { value: 'WHATSAPP', label: 'WhatsApp' },
              { value: 'SMS', label: 'SMS' },
            ]}
          />
          <Button tone={tone} label="Recibir código" loading={busy} onPress={() => void request()} />
        </>
      ) : (
        <>
          <Text>Código enviado por {channel === 'SMS' ? 'SMS' : 'WhatsApp'} a {phone}</Text>
          <Field
            label="Código de 6 dígitos"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            value={code}
            onChangeText={(v) => {
              setCode(v);
              if (v.length === 6) void verify(v);
            }}
          />
          <Button tone={tone} label="Entrar" loading={busy} onPress={() => void verify()} />
          <Button
            tone={tone}
            variant="outline"
            label={resendIn > 0 ? `Reenviar en ${resendIn} s` : 'Reenviar código'}
            disabled={resendIn > 0 || busy}
            onPress={() => void request()}
          />
          <Button tone="neutral" variant="outline" label="Cambiar número" onPress={() => setPhone(null)} />
        </>
      )}

      {error ? <Text style={{ color: palette.danger }}>{error}</Text> : null}
      {footer}
    </Screen>
  );
}
