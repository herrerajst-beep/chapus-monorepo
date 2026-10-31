/**
 * Extrae el Código Postal español (01000-52999) y la localidad acotada (máx 20 caracteres)
 * evitando capturar el nombre del país cuando el texto carece de coma separadora.
 */
const SPANISH_CP_LOCALITY_REGEX =
  /(?:^|\b)((?:0[1-9]|[1-4]\d|5[0-2])\d{3})\s+([A-Za-záéíóúÁÉÍÓÚñÑüÜ\-]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑüÜ\-]+){0,2}?)(?=\s+(?:España|Spain)\b|\s*,|$)/i;

export function deriveApproximateZone(
  explicitZone: string | undefined,
  addressText: string,
  lat: number,
  lng: number
): string {
  if (explicitZone && explicitZone.trim().length >= 3) {
    return explicitZone.trim().slice(0, 150);
  }

  // Normalizamos posibles espacios múltiples
  const normalizedAddress = addressText.replace(/\s+/g, ' ').trim();
  const match = normalizedAddress.match(SPANISH_CP_LOCALITY_REGEX);

  if (match) {
    const postalCode = match[1];
    // Acotación estricta a 20 caracteres y limpieza de sufijos residuales
    const rawLocality = match[2]
      .replace(/\b(España|Spain)\b/gi, '')
      .trim()
      .slice(0, 20)
      .trim();

    return rawLocality.length > 0
      ? `CP ${postalCode} (${rawLocality})`
      : `Zona CP ${postalCode}`;
  }

  // Fallback si solo aparece el CP de 5 dígitos sin localidad detrás (ej. "28014, Madrid")
  const standaloneCpMatch = normalizedAddress.match(/\b((?:0[1-9]|[1-4]\d|5[0-2])\d{3})\b/);
  if (standaloneCpMatch) {
    return `Zona CP ${standaloneCpMatch[1]}`;
  }

  // Último recurso determinista basado en cuadrícula geográfica (~1.1 km)
  return `Sector (${lat.toFixed(2)}, ${lng.toFixed(2)})`;
}
