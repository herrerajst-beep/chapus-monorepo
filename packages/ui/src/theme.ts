export const palette = {
  /** Acción principal del cliente. */
  brand: '#0F766E',
  brandSoft: '#CCFBF1',
  /** Naranja corporativo de Acción Proveedor (coincide con el color del push Android). */
  provider: '#F97316',
  providerSoft: '#FFEDD5',
  danger: '#DC2626',
  success: '#16A34A',
  ink: '#0F172A',
  inkMuted: '#64748B',
  line: '#E2E8F0',
  surface: '#FFFFFF',
  background: '#F8FAFC',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 20, pill: 999 } as const;

export const typography = {
  title: { fontSize: 24, fontWeight: '700' },
  heading: { fontSize: 18, fontWeight: '600' },
  body: { fontSize: 16, fontWeight: '400' },
  caption: { fontSize: 13, fontWeight: '400' },
  price: { fontSize: 28, fontWeight: '800', fontVariant: ['tabular-nums'] },
} as const;

export type Tone = 'brand' | 'provider' | 'danger' | 'neutral';

export const toneColor: Record<Tone, { solid: string; soft: string }> = {
  brand: { solid: palette.brand, soft: palette.brandSoft },
  provider: { solid: palette.provider, soft: palette.providerSoft },
  danger: { solid: palette.danger, soft: '#FEE2E2' },
  neutral: { solid: palette.ink, soft: palette.line },
};
