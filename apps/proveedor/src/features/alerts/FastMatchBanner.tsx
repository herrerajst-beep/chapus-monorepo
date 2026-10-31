import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isApiError, useCategories, useFastAccept } from '@chapus/api';
import { FAST_MATCH_ALERT_TTL_MS, formatDistance, formatEur } from '@chapus/core';
import { Button, Text, palette, radius, space } from '@chapus/ui';
import { useAlerts, type JobAlert } from './store';

const startedAt = (a: JobAlert) => (a.request ? Date.parse(a.request.createdAt) : a.receivedAt);

/**
 * Oferta Fast-Match sobre cualquier pantalla. Se pinta desde el store en el mismo tick
 * en que llega el evento (sin fetch ni navegación) para cumplir el objetivo de <150 ms.
 */
export function FastMatchBanner() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const alert = useAlerts((s) => s.alerts.find((a) => a.pricingModel === 'FAST_MATCH'));
  const dismiss = useAlerts((s) => s.dismiss);
  const fastAccept = useFastAccept();
  const categories = useCategories();
  const categoryName = (id: number) => categories.data?.find((c) => c.id === id)?.name ?? 'Trabajo';
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setNotice(null);
    setNow(Date.now());
    if (!alert) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [alert?.requestId]);

  if (!alert) return null;
  const secondsLeft = Math.max(0, Math.ceil((startedAt(alert) + FAST_MATCH_ALERT_TTL_MS - now) / 1_000));
  // En la ficha de esa misma alerta ya se ve el botón de aceptar.
  if (secondsLeft === 0 || pathname === `/alert/${alert.requestId}`) return null;

  const id = alert.requestId;
  const accept = () =>
    fastAccept.mutate(id, {
      onSuccess: () => {
        dismiss(id);
        router.push({ pathname: '/job/[id]', params: { id } });
      },
      onError: (e) => {
        if (isApiError(e, 409)) {
          setNotice('Otro profesional lo aceptó antes.');
          setTimeout(() => dismiss(id), 1_500);
        } else if (isApiError(e, 403)) {
          dismiss(id);
          router.push('/kyc');
        } else setNotice('No se pudo aceptar. Inténtalo de nuevo.');
      },
    });

  return (
    <View style={[styles.wrap, { paddingBottom: insets.bottom + space.md }]} accessibilityLiveRegion="assertive">
      <View style={styles.row}>
        <Text variant="heading" style={{ color: palette.provider }}>⚡ Trabajo directo</Text>
        <Text variant="caption" muted>{secondsLeft} s</Text>
      </View>
      <Pressable onPress={() => router.push({ pathname: '/alert/[id]', params: { id } })} accessibilityRole="link">
        <View style={styles.row}>
          <Text variant="title">{alert.offeredPriceEur ? formatEur(alert.offeredPriceEur) : 'Precio cerrado'}</Text>
          {alert.request ? <Text muted>{formatDistance(alert.request.distanceKm)}</Text> : null}
        </View>
        <Text numberOfLines={1} muted>
          {alert.request ? `${categoryName(alert.request.categoryId)} · ${alert.request.addressText}` : 'Toca para ver los detalles'}
        </Text>
      </Pressable>
      {notice ? <Text style={{ color: palette.danger }}>{notice}</Text> : null}
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Button tone="neutral" variant="outline" label="Ignorar" onPress={() => dismiss(id)} />
        </View>
        <View style={{ flex: 2 }}>
          <Button tone="provider" label="Aceptar" loading={fastAccept.isPending} onPress={accept} />
        </View>
      </View>
    </View>
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
});
