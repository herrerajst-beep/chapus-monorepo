import { Server as SocketServer } from 'socket.io';
import * as admin from 'firebase-admin';
import {
  ServiceRequestRow,
  ServiceRequestSerializer,
} from '../bookings/serializers/service-request.serializer';

interface DeviceAckPayload {
  received?: boolean;
  deviceId?: string;
  clientTimestamp?: number;
}

interface AckTelemetryResult {
  acknowledged: boolean;
  ackDeltaMs: number | null;
  respondedDevicesCount: number;
}

export class GeoDispatcherService {
  constructor(
    private readonly io: SocketServer,
    private readonly fcm: admin.messaging.Messaging,
    private readonly logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }
  ) {}

  public async dispatchJobOffer(
    rawRequestRow: ServiceRequestRow,
    candidates: Array<{ providerId: string; fcmToken: string | null; distanceKm: number }>,
    waveNumber: number = 1
  ) {
    const dispatchBatchStartNs = process.hrtime.bigint();
    const pushTokensFallback: string[] = [];
    const ackLatenciesMs: number[] = [];

    await Promise.all(
      candidates.map(async (candidate) => {
        // 1. Serialización estricta: garantiza que addressText es NULL e isAddressMasked es TRUE
        const safeDto = ServiceRequestSerializer.toDTO(
          { ...rawRequestRow, distance_km: candidate.distanceKm },
          candidate.providerId
        );

        const providerRoom = `provider:${candidate.providerId}`;

        // 2. Emisión instrumentada con medición de diferencial de tiempo (Emit -> ACK)
        const telemetry = await this.emitWithLatencyTelemetry(
          rawRequestRow.id,
          candidate.providerId,
          rawRequestRow.pricing_model,
          providerRoom,
          'geo:job_alert',
          { request: safeDto, distanceKm: candidate.distanceKm },
          1500
        );

        if (telemetry.acknowledged && telemetry.ackDeltaMs !== null) {
          ackLatenciesMs.push(telemetry.ackDeltaMs);
          return; // Cortocircuito: aborta el envío de Push para ahorrar costes SNS/FCM
        }

        if (candidate.fcmToken) {
          pushTokensFallback.push(candidate.fcmToken);
        }
      })
    );

    // 3. Log agregado de la oleada para análisis de viabilidad del modelo Fast-Match
    const totalBatchDurationMs = Number(process.hrtime.bigint() - dispatchBatchStartNs) / 1e6;
    this.logWaveViabilityMetrics(
      rawRequestRow.id,
      rawRequestRow.pricing_model,
      waveNumber,
      candidates.length,
      ackLatenciesMs,
      pushTokensFallback.length,
      totalBatchDurationMs
    );

    // 4. Disparo de Push únicamente para proveedores sin socket activo o con timeout agotado
    if (pushTokensFallback.length > 0) {
      await this.sendBatchPushFallback(rawRequestRow, pushTokensFallback);
    }
  }

  /**
   * Mide con reloj monotónico (hrtime) los milisegundos exactos entre la salida del frame
   * WebSocket y la recepción del ACK del proveedor, inyectando la métrica en los logs.
   */
  private emitWithLatencyTelemetry(
    requestId: string,
    providerId: string,
    pricingModel: string,
    room: string,
    event: string,
    payload: unknown,
    timeoutMs: number
  ): Promise<AckTelemetryResult> {
    return new Promise((resolve) => {
      const offersNamespace = this.io.of('/offers');
      const roomSockets = offersNamespace.adapter.rooms.get(room);

      if (!roomSockets || roomSockets.size === 0) {
        this.logger.info(
          {
            metric: 'ws_dispatch_ack',
            requestId,
            providerId,
            pricingModel,
            status: 'NO_ACTIVE_SOCKET',
            ackDeltaMs: null,
          },
          '[Dispatcher] Proveedor sin socket activo en sala; enrutando a Push Fallback'
        );
        return resolve({ acknowledged: false, ackDeltaMs: null, respondedDevicesCount: 0 });
      }

      // Marca de tiempo monotónica justo antes de escribir en el buffer del socket
      const emitStartNs = process.hrtime.bigint();

      offersNamespace
        .to(room)
        .timeout(timeoutMs)
        .emit(event, payload, (err: Error | null, responses?: DeviceAckPayload[]) => {
          const ackReceivedNs = process.hrtime.bigint();
          // Conversión de nanosegundos a milisegundos con 2 decimales de precisión
          const ackDeltaMs = Number((Number(ackReceivedNs - emitStartNs) / 1e6).toFixed(2));

          const validAcks = Array.isArray(responses)
            ? responses.filter(
                (ack) => ack !== null && typeof ack === 'object' && ack.received === true
              )
            : [];

          if (validAcks.length > 0) {
            this.logger.info(
              {
                metric: 'ws_dispatch_ack',
                requestId,
                providerId,
                pricingModel,
                status: 'ACK_RECEIVED',
                ackDeltaMs,
                activeSocketsInRoom: roomSockets.size,
                respondedDevicesCount: validAcks.length,
                partialTimeoutOccurred: Boolean(err),
              },
              `[Dispatcher] ACK recibido de proveedor ${providerId} en ${ackDeltaMs}ms`
            );

            return resolve({
              acknowledged: true,
              ackDeltaMs,
              respondedDevicesCount: validAcks.length,
            });
          }

          this.logger.warn(
            {
              metric: 'ws_dispatch_ack',
              requestId,
              providerId,
              pricingModel,
              status: 'ACK_TIMEOUT',
              ackDeltaMs,
              timeoutThresholdMs: timeoutMs,
              activeSocketsInRoom: roomSockets.size,
            },
            `[Dispatcher] Timeout de ACK (${ackDeltaMs}ms) para proveedor ${providerId}; activando Push Fallback`
          );

          return resolve({
            acknowledged: false,
            ackDeltaMs: null,
            respondedDevicesCount: 0,
          });
        });
    });
  }

  /**
   * Registra las estadísticas consolidadas (Min, Avg, P95, Max y Ratio de Conversión WS vs Push)
   * para evaluar la viabilidad técnica del modelo Fast-Match en producción.
   */
  private logWaveViabilityMetrics(
    requestId: string,
    pricingModel: string,
    waveNumber: number,
    totalCandidates: number,
    ackLatenciesMs: number[],
    fallbackPushCount: number,
    totalBatchDurationMs: number
  ) {
    const sorted = [...ackLatenciesMs].sort((a, b) => a - b);
    const count = sorted.length;

    const minMs = count > 0 ? sorted[0] : null;
    const maxMs = count > 0 ? sorted[count - 1] : null;
    const avgMs =
      count > 0 ? Number((sorted.reduce((a, b) => a + b, 0) / count).toFixed(2)) : null;
    const p95Index = count > 0 ? Math.min(count - 1, Math.floor(count * 0.95)) : 0;
    const p95Ms = count > 0 ? sorted[p95Index] : null;

    this.logger.info(
      {
        metric: 'fast_match_wave_viability',
        requestId,
        pricingModel,
        waveNumber,
        totalCandidates,
        wsAckSuccessCount: count,
        pushFallbackCount: fallbackPushCount,
        wsDeliveryRatePercent:
          totalCandidates > 0 ? Number(((count / totalCandidates) * 100).toFixed(1)) : 0,
        latencyStatsMs: {
          min: minMs,
          avg: avgMs,
          p95: p95Ms,
          max: maxMs,
        },
        totalWaveExecutionMs: Number(totalBatchDurationMs.toFixed(2)),
      },
      `[Fast-Match Telemetry] Ola #${waveNumber} completada para solicitud ${requestId} (P95 ACK: ${p95Ms ?? 'N/A'}ms)`
    );
  }

  private async sendBatchPushFallback(rawRow: ServiceRequestRow, tokens: string[]) {
    await this.fcm.sendEachForMulticast({
      tokens,
      data: {
        type: 'NEW_JOB_ALERT',
        requestId: String(rawRow.id),
        pricingModel: String(rawRow.pricing_model),
        approximateZone: String(rawRow.approximate_zone), // Dirección exacta jamás viaja por FCM
      },
      android: {
        priority: 'high',
        ttl: 45000,
      },
    });
  }
}
