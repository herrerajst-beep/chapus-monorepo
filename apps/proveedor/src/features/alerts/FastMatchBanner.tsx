import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isApiError, useCategories, useFastAccept } from '@chapus/api';
import { FAST_MATCH_ALERT_TTL_MS, formatDistance, formatEur } from '@chapus/core';
import { Button, Text, palette, radius, space } from '@chapus/ui';
import { useLatency } from '@/features/diagnostics/latency';
import { TAKEN_LINGER_MS, useAlerts, type JobAlert } from './store';

const startedAt = (a: JobAlert) => (a.request ? Date.parse(a.request.createdAt) : a.receivedAt);
const FADE_MS = 600;

/**
 * Oferta Fast-Match sobre cualquier pantalla. Se pinta desde el store en el mismo tick
 * en que llega el evento (sin fetch ni navegación) para cumplir el objetivo de <150 ms.
 *
 * Si la oportunidad se pierde (geo:job_taken o 409 al aceptar) no desaparece de golpe:
 * pasa a un estado gris «Otro profesional se adelantó», vibra una vez y se desvanece.
 */
export function FastMatchBanner() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const alert = useAlerts((s) => s.alerts.find((a) => a.pricingModel === 'FAST_MATCH'));
  const dismiss = useAlerts((s) => s.dismiss);
  const markTaken = useAlerts((s) => s.markTaken);
  const markRendered = useLatency((s) => s.markRendered);
  const fastAccept = useFastAccept();
  const categories = useCategories();
  const categoryName = (id: number) => categories.data?.find((c) => c.id === id)?.name ?? 'Trabajo';
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(1)).current;

  const taken = alert?.takenAt !== undefined;

  useEffect(() => {
    setNotice(null);
    setNow(Date.now());
    opacity.setValue(1);
    if (!alert) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [alert?.requestId, opacity]);

  useEffect(() => {
    if (!taken) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    const fade = Animated.timing(opacity, {
      toValue: 0,
      duration: FADE_MS,
      delay: TAKEN_LINGER_MS - FADE_MS,
      useNativeDriver: true,
    });
    fade.start();
    return () => fade.stop();
  }, [taken, opacity]);

  if (!alert) return null;
  const secondsLeft = Math.max(0, Math.ceil((startedAt(alert) + FAST_MATCH_ALERT_TTL_MS - now) / 1_000));
  // En la ficha de esa misma alerta ya se ve el botón de aceptar.
  if ((secondsLeft === 0 && !taken) || pathname === `/alert/${alert.requestId}`) return null;

  const id = alert.requestId;
  const accept = () =>
    fastAccept.mutate(id, {
      onSuccess: () => {
        dismiss(id);
        router.push({ pathname: '/job/[id]', params: { id } });
      },
      onError: (e) => {
        if (isApiError(e, 409)) markTaken(id);
        else if (isApiError(e, 403) && e.errorCode === 'KYC_VERIFICATION_REQUIRED') {
          dismiss(id);
          router.push('/kyc');
        } else if (isApiError(e, 403)) markTaken(id);
        else setNotice('No se pudo aceptar. Inténtalo de nuevo.');
      },
    });

  return (
    <Animated.View
      style={[
        styles.wrap,
        { paddingBottom: insets.bottom + space.md, opacity },
        taken && { borderColor: palette.inkMuted },
      ]}
      accessibilityLiveRegion="assertive"
      onLayout={() => markRendered(id)}
    >
      <View style={styles.row}>
        <Text variant="heading" style={{ color: taken ? palette.inkMuted : palette.provider }}>
          {taken ? 'Otro profesional se adelantó' : '⚡ Trabajo directo'}
        </Text>
        {!taken ? <Text variant="caption" muted>{secondsLeft} s</Text> : null}
      </View>
      <Pressable
        disabled={taken}
        onPress={() => router.push({ pathname: '/alert/[id]', params: { id } })}
        accessibilityRole="link"
      >
        <View style={styles.row}>
          <Text variant="title" style={taken ? styles.struck : undefined}>
            {alert.offeredPriceEur ? formatEur(alert.offeredPriceEur) : 'Precio cerrado'}
          </Text>
          {alert.request ? <Text muted>{formatDistance(alert.request.distanceKm)}</Text> : null}
        </View>
        <Text numberOfLines={1} muted>
          {alert.request
            ? `${categoryName(alert.request.categoryId)} · ${alert.request.approximateZone}`
            : (alert.approximateZone ?? 'Toca para ver los detalles')}
        </Text>
      </Pressable>
      {taken ? (
        <Text variant="caption" muted>Sigue disponible: te avisaremos del próximo trabajo cerca.</Text>
      ) : (
        <>
          {notice ? <Text style={{ color: palette.danger }}>{notice}</Text> : null}
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Button tone="neutral" variant="outline" label="Ignorar" onPress={() => dismiss(id)} />
            </View>
            <View style={{ flex: 2 }}>
              <Button tone="provider" label="Aceptar" loading={fastAccept.isPending} onPress={accept} />
            </View>
          </View>
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: space.sm,
    padding: space.lg,
    backgroundColor: palette.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 3,
    borderColor: palette.provider,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 12,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  struck: { textDecorationLine: 'line-through', color: palette.inkMuted },
});
