/**
 * Exige que los 5 dígitos del CP español (01000-52999) aparezcan al inicio o tras una coma/guion,
 * evitando confundir números de portal de 5 cifras (ej. "Calle Toledo 12345") con un CP.
 */
const SPANISH_CP_LOCALITY_REGEX =
  /(?:^|[,;\-]\s*)((?:0[1-9]|[1-4]\d|5[0-2])\d{3})\s+([A-Za-záéíóúÁÉÍÓÚñÑüÜ\-]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑüÜ\-]+){0,2}?)(?=\s+(?:España|Spain)\b|\s*[.,;]|$)/i;

export function deriveApproximateZone(
  explicitZone: string | undefined,
  addressText: string,
  lat: number,
  lng: number
): string {
  if (explicitZone && explicitZone.trim().length >= 3) {
    return explicitZone.trim().slice(0, 150);
  }

  const normalized = addressText.replace(/\s+/g, ' ').replace(/\.+$/, '').trim();
  const match = normalized.match(SPANISH_CP_LOCALITY_REGEX);

  if (match) {
    const postalCode = match[1];
    const rawLocality = match[2]
      .replace(/\b(España|Spain)\b/gi, '')
      .replace(/[.,;]+$/, '')
      .trim()
      .slice(0, 20)
      .trim();

    return rawLocality.length > 0
      ? `CP ${postalCode} (${rawLocality})`
      : `Zona CP ${postalCode}`;
  }

  // Fallback solo si el CP de 5 dígitos va precedido de coma (ej. "Calle Mayor 4, 22600")
  const commaCpMatch = normalized.match(/,\s*((?:0[1-9]|[1-4]\d|5[0-2])\d{3})\b/);
  if (commaCpMatch) {
    return `Zona CP ${commaCpMatch[1]}`;
  }

  return `Sector (${lat.toFixed(2)}, ${lng.toFixed(2)})`;
}
