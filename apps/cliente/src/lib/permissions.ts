import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { ensurePermission } from '@chapus/ui';

/**
 * Cuándo se pide cada permiso (nunca en el arranque):
 * - Ubicación: al pulsar «Usar mi ubicación» en la solicitud (se puede escribir la dirección).
 * - Cámara: al pulsar «Cámara» para fotografiar la avería.
 * - Galería: no se pide. El selector del sistema (PHPicker / Android Photo Picker) no
 *   requiere permiso de biblioteca.
 */

export const ensureLocation = () =>
  ensurePermission({
    get: Location.getForegroundPermissionsAsync,
    request: Location.requestForegroundPermissionsAsync,
    primer: {
      icon: '📍',
      title: 'Encuentra profesionales cerca de ti',
      body: 'Usamos tu ubicación solo para enviar tu solicitud a los profesionales más cercanos y rellenar la dirección. No la seguimos en segundo plano.',
      allowLabel: 'Usar mi ubicación',
    },
  });

export const ensureCamera = () =>
  ensurePermission({
    get: ImagePicker.getCameraPermissionsAsync,
    request: ImagePicker.requestCameraPermissionsAsync,
    primer: {
      icon: '📷',
      title: 'Fotografía la avería',
      body: 'Con una foto del problema los profesionales te dan un presupuesto más preciso. Solo se envían las fotos que elijas.',
      allowLabel: 'Abrir cámara',
    },
  });
