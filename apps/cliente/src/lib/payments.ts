import * as Linking from 'expo-linking';
import { initPaymentSheet, initStripe, presentPaymentSheet } from '@stripe/stripe-react-native';
import { createStallMonitor, type PaymentSheetPayload } from '@chapus/core';

const AUDIT = __DEV__ || process.env.EXPO_PUBLIC_DIAGNOSTICS === '1';

export type PaymentResult = { status: 'paid' } | { status: 'canceled' } | { status: 'failed'; message: string };

const returnURL = Linking.createURL('stripe-redirect');
let initializedKey: string | null = null;

/**
 * Deposita el importe en Escrow con el PaymentSheet de Stripe. Las claves llegan del backend
 * en cada checkout (POST /requests o /bids/{bidId}/accept), incluida la publishableKey.
 */
export async function payWithSheet(payload: PaymentSheetPayload): Promise<PaymentResult> {
  if (initializedKey !== payload.publishableKey) {
    await initStripe({
      publishableKey: payload.publishableKey,
      merchantIdentifier: 'merchant.es.chapus',
      urlScheme: Linking.createURL('').split(':')[0],
    });
    initializedKey = payload.publishableKey;
  }

  // Auditoría: el PaymentSheet es nativo; el hilo JS no debería bloquearse (>50 ms) mientras se abre.
  const monitor = AUDIT ? createStallMonitor() : null;
  const t0 = Date.now();
  const init = await initPaymentSheet({
    merchantDisplayName: 'Chapus',
    customerId: payload.customerId,
    customerEphemeralKeySecret: payload.ephemeralKey,
    paymentIntentClientSecret: payload.paymentIntentClientSecret,
    returnURL,
    applePay: { merchantCountryCode: 'ES' },
    googlePay: { merchantCountryCode: 'ES', testEnv: __DEV__ },
    defaultBillingDetails: { address: { country: 'ES' } },
  });
  const initMs = Date.now() - t0;
  if (init.error) {
    monitor?.stop();
    return { status: 'failed', message: init.error.message };
  }

  const { error } = await presentPaymentSheet();
  if (monitor) {
    const { maxStallMs, stalls } = monitor.stop();
    console.info(`[payments] init ${initMs} ms · sheet abierto ${Date.now() - t0 - initMs} ms · bloqueo JS máx ${maxStallMs} ms (${stalls} >50 ms)`);
  }
  if (!error) return { status: 'paid' };
  if (error.code === 'Canceled') return { status: 'canceled' };
  return { status: 'failed', message: error.message };
}
