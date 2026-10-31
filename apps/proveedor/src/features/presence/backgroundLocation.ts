import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { api } from '@/lib/api';

export const BACKGROUND_LOCATION_TASK = 'chapus-provider-location';

/**
 * Debe definirse en el ámbito del módulo e importarse desde el entry (index.ts), porque el
 * sistema puede arrancar la app en headless solo para entregar posiciones.
 */
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const last = data.locations.at(-1);
  if (!last) return;
  try {
    await api.heartbeat({ lat: last.coords.latitude, lng: last.coords.longitude }, true);
  } catch {
    // Sin red: el siguiente lote lo reintentará.
  }
});

export async function startBackgroundLocation() {
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 150,
    deferredUpdatesInterval: 60_000,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Chapus Pro: estás disponible',
      notificationBody: 'Recibiendo trabajos cerca de ti. Desactívalo poniéndote «No disponible».',
      notificationColor: '#F97316',
    },
  });
}

export async function stopBackgroundLocation() {
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}
