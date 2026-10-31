import * as Linking from 'expo-linking';
import { initPaymentSheet, initStripe, presentPaymentSheet } from '@stripe/stripe-react-native';
import type { PaymentSheetPayload } from '@chapus/core';

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
  if (init.error) return { status: 'failed', message: init.error.message };

  const { error } = await presentPaymentSheet();
  if (!error) return { status: 'paid' };
  if (error.code === 'Canceled') return { status: 'canceled' };
  return { status: 'failed', message: error.message };
}
