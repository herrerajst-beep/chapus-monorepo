// packages/backend/src/modules/dispatch/geo-dispatcher.service.ts
import { Server as SocketServer } from 'socket.io';
import * as admin from 'firebase-admin';
import { Redis } from 'ioredis';

interface CandidateProvider {
  providerId: string;
  fcmToken: string | null;
  distanceKm: number;
}

export class GeoDispatcherService {
  constructor(
    private readonly io: SocketServer,
    private readonly redis: Redis,
    private readonly fcm: admin.messaging.Messaging
  ) {}

  async dispatchJobOffer(requestPayload: any, candidates: CandidateProvider[]) {
    const pushTokensFallback: string[] = [];

    await Promise.all(
      candidates.map(async (candidate) => {
        const socketId = await this.redis.get(`ws:provider:${candidate.providerId}`);

        if (socketId) {
          // 1. Vía Rápida: Profesional con conexión WebSocket activa
          const deliveredViaWs = await this.emitWithAckTimeout(
            socketId,
            'geo:job_alert',
            { ...requestPayload, distanceKm: candidate.distanceKm },
            1500 // 1.5s timeout para recibir ACK del móvil
          );

          // Si el socket estaba "zombie" (ej. entrando a un ascensor sin cobertura), cae a Push
          if (!deliveredViaWs && candidate.fcmToken) {
            pushTokensFallback.push(candidate.fcmToken);
          }
        } else if (candidate.fcmToken) {
          // 2. Vía Respaldo: Profesional con app cerrada o en background profundo
          pushTokensFallback.push(candidate.fcmToken);
        }
      })
    );

    // Envío multicast por lotes a través de FCM/APNs
    if (pushTokensFallback.length > 0) {
      await this.fcm.sendEachForMulticast({
        tokens: pushTokensFallback,
        data: {
          type: 'NEW_JOB_ALERT',
          requestId: String(requestPayload.id),
          pricingModel: String(requestPayload.pricingModel),
          offeredPriceEur: String(requestPayload.offeredPriceEur || ''),
          distanceKm: 'Calculando...',
        },
        android: {
          priority: 'high',
          ttl: 45000, // Caduca en 45s si el trabajo es de respuesta inmediata
          notification: {
            channelId: 'chapus_urgent_jobs', // Canal con sonido de alerta personalizado
            title: requestPayload.pricingModel === 'FAST_MATCH' 
              ? `⚡ ¡Trabajo Directo: ${requestPayload.offeredPriceEur}€!` 
              : `📋 Nueva solicitud de presupuesto cerca`,
            body: `${requestPayload.categoryName} - ${requestPayload.addressText}`,
            color: '#F97316', // Naranja corporativo de Acción Proveedor
          },
        },
        apns: {
          headers: {
            'apns-priority': '10', // Despierta el iPhone inmediatamente
            'apns-expiration': String(Math.floor(Date.now() / 1000) + 45),
          },
          payload: {
            aps: {
              alert: {
                title: `⚡ Oportunidad Chapus (${requestPayload.offeredPriceEur}€)`,
                body: requestPayload.description,
              },
              sound: 'urgent_alert.wav',
              'content-available': 1,
            },
          },
        },
      });
    }
  }

  private emitWithAckTimeout(socketId: string, event: string, data: any, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.io.to(socketId).timeout(timeoutMs).emit(event, data, (err: any, response: any) => {
        if (err || !response?.received) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }
}