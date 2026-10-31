/**
 * El enmascaramiento de domicilio lo decide el servidor (ServiceRequestSerializer):
 * la UI se guía solo por `isAddressMasked`, `addressText` y `approximateZone`.
 */

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
