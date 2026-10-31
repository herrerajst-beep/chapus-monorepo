export * from './domain';
export * from './realtime';
export * from './validation';

const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

export const formatEur = (amount: number) => eur.format(amount);

export const formatDistance = (km: number) =>
  km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1).replace('.', ',')} km`;
