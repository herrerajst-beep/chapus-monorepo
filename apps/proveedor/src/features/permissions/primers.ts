import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { ensurePermission } from '@chapus/ui';

/**
 * Orden de petición (nunca en el arranque):
 * 1. Ubicación "mientras se usa": al activar "Disponible".
 * 2. Notificaciones: justo después, en el mismo gesto de ponerse disponible.
 * 3. Ubicación en segundo plano: opt-in explícito desde el radar, ya online.
 */

export const ensureForegroundLocation = () =>
  ensurePermission({
    get: Location.getForegroundPermissionsAsync,
    request: Location.requestForegroundPermissionsAsync,
    primer: {
      icon: '📍',
      tone: 'provider',
      title: 'Recibe trabajos en tu zona',
      body: 'Necesitamos tu ubicación para enviarte alertas de trabajo cerca de ti y calcular la distancia hasta cada cliente. Solo la usamos mientras estás «Disponible».',
      allowLabel: 'Permitir ubicación',
    },
  });

export const ensureNotifications = () =>
  ensurePermission({
    get: Notifications.getPermissionsAsync,
    request: () => Notifications.requestPermissionsAsync(),
    primer: {
      icon: '🔔',
      tone: 'provider',
      title: 'No te pierdas ningún trabajo',
      body: 'Los trabajos de precio cerrado se adjudican en segundos. Te avisaremos con un sonido aunque tengas el móvil bloqueado o la app cerrada.',
      allowLabel: 'Activar avisos',
    },
  });

/** Requiere el permiso "mientras se usa" ya concedido (Android 11+ e iOS lo exigen en dos pasos). */
export const ensureBackgroundLocation = () =>
  ensurePermission({
    get: Location.getBackgroundPermissionsAsync,
    request: Location.requestBackgroundPermissionsAsync,
    primer: {
      icon: '🛰️',
      tone: 'provider',
      title: 'Sigue disponible con la app cerrada',
      body: 'Si lo activas, actualizaremos tu posición aunque uses otras apps, para que los clientes cercanos te encuentren. Verás un aviso permanente mientras estés disponible y puedes desactivarlo en cualquier momento.',
      // Texto de "prominent disclosure" exigido por Google Play para ACCESS_BACKGROUND_LOCATION.
      disclosure:
        'Chapus Pro recopila datos de ubicación para enviarte trabajos cercanos incluso cuando la app está cerrada o no se está usando. Solo mientras tu estado sea «Disponible».',
      allowLabel: 'Activar en segundo plano',
    },
  });
