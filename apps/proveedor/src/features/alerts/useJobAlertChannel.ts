import { useEffect } from 'react';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { isJobAlertPushData, type JobAlertPushData, type OffersServerEvents } from '@chapus/core';
import { offersSocket } from '@/lib/api';
import { useAlerts } from './store';

const fromPush = (data: JobAlertPushData) => ({
  requestId: data.requestId,
  pricingModel: data.pricingModel,
  offeredPriceEur: data.offeredPriceEur ? Number(data.offeredPriceEur) : undefined,
  receivedAt: Date.now(),
  source: 'push' as const,
});

/**
 * Canal unificado de alertas de trabajo: WebSocket /offers (vía rápida con ACK) + push
 * (respaldo). Montar una sola vez en el layout raíz.
 */
export function useJobAlertChannel() {
  useEffect(() => {
    const { receive, dismiss, prune } = useAlerts.getState();

    // 1. Vía rápida. El dispatcher espera `{ received: true }` en ≤1,5 s; si no llega,
    //    reenvía por push. Se confirma ANTES de cualquier trabajo para no agotar el timeout.
    const onJobAlert: OffersServerEvents['geo:job_alert'] = ({ request, distanceKm }, ack) => {
      ack({ received: true, timestamp: Date.now() });
      receive({
        requestId: request.id,
        pricingModel: request.pricingModel,
        offeredPriceEur: request.offeredPriceEur,
        receivedAt: Date.now(),
        source: 'ws',
        request: { ...request, distanceKm },
      });
    };
    const onJobTaken: OffersServerEvents['geo:job_taken'] = ({ requestId }) => dismiss(requestId);

    offersSocket.on('geo:job_alert', onJobAlert);
    offersSocket.on('geo:job_taken', onJobTaken);

    // 2. Respaldo push con la app en primer plano.
    const received = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data;
      if (isJobAlertPushData(data)) receive(fromPush(data));
    });

    // 3. El profesional pulsa la notificación (app en background o cerrada).
    const openAlert = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data;
      if (!isJobAlertPushData(data)) return;
      receive(fromPush(data));
      router.push({ pathname: '/alert/[id]', params: { id: data.requestId } });
    };
    const tapped = Notifications.addNotificationResponseReceivedListener(openAlert);
    Notifications.getLastNotificationResponseAsync().then((r) => r && openAlert(r));

    const timer = setInterval(prune, 5_000);

    return () => {
      offersSocket.off('geo:job_alert', onJobAlert);
      offersSocket.off('geo:job_taken', onJobTaken);
      received.remove();
      tapped.remove();
      clearInterval(timer);
    };
  }, []);
}
