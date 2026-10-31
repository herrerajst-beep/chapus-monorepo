import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

/** Debe coincidir con `channelId` del GeoDispatcherService. */
export const URGENT_CHANNEL_ID = 'chapus_urgent_jobs';

Notifications.setNotificationHandler({
  // En primer plano la alerta se muestra dentro de la app (banner propio + sonido del sistema).
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: true,
  }),
});

export async function setupNotificationChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(URGENT_CHANNEL_ID, {
    name: 'Trabajos urgentes',
    description: 'Avisos de trabajos cercanos con respuesta inmediata',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'urgent_alert.wav',
    vibrationPattern: [0, 400, 200, 400],
    lightColor: '#F97316',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

/**
 * Token nativo (FCM en Android / APNs en iOS): el backend usa firebase-admin directamente,
 * no Expo Push Service. NO pide permiso: eso lo hace `ensureNotifications()` con su
 * pantalla de justificación. Devuelve null en simulador o sin permiso.
 */
export async function getNativePushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (!(await Notifications.getPermissionsAsync()).granted) return null;
  const token = await Notifications.getDevicePushTokenAsync();
  return typeof token.data === 'string' ? token.data : null;
}
