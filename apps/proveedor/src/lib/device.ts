import * as SecureStore from 'expo-secure-store';

const KEY = 'chapus.pro.deviceId';

// El ACK de `geo:job_alert` debe ser síncrono e inmediato: el id se carga al arrancar y se
// lee de memoria. Hasta entonces se responde con un id temporal de esta ejecución.
let deviceId = `tmp-${Math.random().toString(36).slice(2, 10)}`;

const randomId = () =>
  Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')).join('');

/** Identificador estable de instalación (no es un dato personal ni un IDFA). */
export async function loadDeviceId() {
  const stored = await SecureStore.getItemAsync(KEY).catch(() => null);
  if (stored) {
    deviceId = stored;
    return;
  }
  const fresh = randomId();
  await SecureStore.setItemAsync(KEY, fresh).catch(() => undefined);
  deviceId = fresh;
}

export const getDeviceId = () => deviceId;
