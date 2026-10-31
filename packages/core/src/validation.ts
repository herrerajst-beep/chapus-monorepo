import { z } from 'zod';

const geoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const serviceRequestSchema = z
  .object({
    categoryId: z.number().int().positive(),
    pricingModel: z.enum(['FAST_MATCH', 'BIDDING']),
    offeredPriceEur: z.number().positive().nullable(),
    location: geoPoint,
    addressText: z.string().trim().min(8, 'Indica la dirección completa'),
    description: z.string().trim().min(10, 'Describe el problema (mínimo 10 caracteres)'),
    photoUrls: z.array(z.url()).max(6),
    scheduledAt: z.iso.datetime().nullable().optional(),
  })
  .refine((v) => v.pricingModel !== 'FAST_MATCH' || v.offeredPriceEur !== null, {
    path: ['offeredPriceEur'],
    message: 'El precio es obligatorio en Fast-Match',
  });

/** Debe coincidir con el `pattern` de OtpRequestPayload.phone en el contrato. */
export const SPANISH_PHONE = /^\+34[6789]\d{8}$/;

/** Acepta "600 11 22 33", "600112233" o "+34600112233" y devuelve E.164, o null. */
export function normalizeSpanishPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  const e164 = digits.startsWith('+') ? digits : digits.startsWith('34') && digits.length === 11 ? `+${digits}` : `+34${digits}`;
  return SPANISH_PHONE.test(e164) ? e164 : null;
}

export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos');

export const bidSchema = z.object({
  amountEur: z.number().positive('El importe debe ser mayor que 0').max(10_000),
  estimatedArrivalMinutes: z.number().int().min(5).max(24 * 60),
  notes: z.string().trim().max(500).optional(),
});

/** Devuelve el primer mensaje de error por campo, listo para pintar en formularios. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    out[key] ??= issue.message;
  }
  return out;
}
