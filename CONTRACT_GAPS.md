// packages/backend/src/modules/dispatch/geo-dispatcher.service.ts
import { Server as SocketServer } from 'socket.io';
import * as admin from 'firebase-admin';
import { Redis } from 'ioredis';

interface AckResponse {
  received: boolean;
  timestamp?: number;
}

export class GeoDispatcherService {
  constructor(
    private readonly io: SocketServer,
    private readonly redis: Redis,
    private readonly fcm: admin.messaging.Messaging
  ) {}

  /**
   * PARCHE APLICADO (Socket.IO v4 Broadcast ACK Array):
   * io.to().timeout().emit() devuelve (err, responses: AckResponse[])
   * ya que internamente trata cualquier destino de .to() como una sala (room) de N sockets.
   */
  private emitWithAckTimeout(
    targetSocketOrRoom: string,
    event: string,
    data: unknown,
    timeoutMs: number = 1500
  ): Promise<boolean> {
    return new Promise((resolve) => {
      this.io
        .of('/offers') // Namespace dedicado a proveedores verificados
        .to(targetSocketOrRoom)
        .timeout(timeoutMs)
        .emit(event, data, (err: Error | null, responses?: AckResponse[]) => {
          // Si ningún socket responde a tiempo o el array viene vacío -> Fallback a Push
          if (err || !Array.isArray(responses) || responses.length === 0) {
            return resolve(false);
          }

          // Basta con que al menos una instancia activa del proveedor confirme recepción (ACK)
          const hasValidAck = responses.some((ack) => ack && ack.received === true);
          return resolve(hasValidAck);
        });
    });
  }

  /**
   * Notifica a todos los proveedores del radio que la oferta Fast-Match ya ha sido capturada
   * para retirar inmediatamente la tarjeta naranja (#F97316) de sus pantallas.
   */
  public broadcastJobTaken(requestId: string, notifiedProviderIds: string[], winningProviderId: string) {
    const losingRooms = notifiedProviderIds
      .filter((id) => id !== winningProviderId)
      .map((id) => `provider:${id}`);

    if (losingRooms.length > 0) {
      this.io.of('/offers').to(losingRooms).emit('geo:job_taken', {
        requestId,
        takenAt: new Date().toISOString(),
      });
    }
  }
}