import type { BookingStatus } from './domain';

/** Estados en los que el profesional asignado ve la dirección exacta del domicilio. */
export const ADDRESS_REVEALED_STATUSES: readonly BookingStatus[] = ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'];

export const isAddressRevealed = (status: BookingStatus) => ADDRESS_REVEALED_STATUSES.includes(status);

/**
 * Zona aproximada ("28014 Madrid") a partir de la dirección completa, para mostrar antes
 * de la confirmación del pago. Si no hay código postal, usa el último tramo.
 *
 * Es una protección de UI: la dirección completa sigue llegando en el payload y el backend
 * debería enmascararla hasta ASSIGNED (ver CONTRACT_STATUS.md).
 */
export function approximateZone(addressText: string): string {
  const cp = addressText.match(/\b(\d{5})\b\s*([^,\d][^,]*)?/);
  if (cp) return [cp[1], cp[2]?.trim()].filter(Boolean).join(' ');
  const parts = addressText.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.at(-1) ?? 'Zona cercana';
}

export interface NavigationLinks {
  googleMaps: string;
  waze: string;
  appleMaps: string;
}

/** Enlaces universales https: abren la app nativa si está instalada, si no la web. */
export function navigationLinks({ lat, lng }: { lat: number; lng: number }): NavigationLinks {
  const ll = `${lat},${lng}`;
  return {
    googleMaps: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
    appleMaps: `https://maps.apple.com/?daddr=${ll}&dirflg=d`,
  };
}
