// packages/backend/src/modules/realtime/job-state-broadcaster.ts
import { Server as SocketServer } from 'socket.io';
import {
  ServiceRequestRow,
  ServiceRequestSerializer,
  BookingStatus,
} from '../bookings/serializers/service-request.serializer';

export interface JobUpdatedEventPayload {
  job: ReturnType<typeof ServiceRequestSerializer.toDTO>;
  previousStatus: BookingStatus;
  currentStatus: BookingStatus;
  transitionedAt: string;
}

export class JobStateBroadcaster {
  constructor(private readonly io: SocketServer) {}

  /**
   * Emite `job:updated` tanto al canal del Cliente (/bookings) como al canal del
   * Proveedor (/offers), garantizando que cada parte reciba el DTO serializado
   * según sus permisos RGPD exactos en ese milisegundo.
   */
  public emitJobStateTransition(
    rawRow: ServiceRequestRow,
    previousStatus: BookingStatus
  ): void {
    const transitionedAt = new Date().toISOString();

    // 1. Serializar vista para el Cliente propietario (isAddressMasked: false siempre)
    const clientViewDto = ServiceRequestSerializer.toDTO(rawRow, rawRow.client_id);
    const clientPayload: JobUpdatedEventPayload = {
      job: clientViewDto,
      previousStatus,
      currentStatus: rawRow.status,
      transitionedAt,
    };

    // Emitir al cliente en su sala dedicada de /bookings (soportando job:updated y alias legacy)
    this.io
      .of('/bookings')
      .to(`client:${rawRow.client_id}`)
      .to(`request:${rawRow.id}`)
      .emit('job:updated', clientPayload);

    // 2. Si existe un proveedor vinculado (pre-asignado en AWAITING_PAYMENT o adjudicado en >= ASSIGNED),
    // serializamos su vista específica (en AWAITING_PAYMENT verá addressText: null; en ASSIGNED verá la dirección exacta).
    if (rawRow.assigned_provider_id) {
      const providerViewDto = ServiceRequestSerializer.toDTO(
        rawRow,
        rawRow.assigned_provider_id
      );

      const providerPayload: JobUpdatedEventPayload = {
        job: providerViewDto,
        previousStatus,
        currentStatus: rawRow.status,
        transitionedAt,
      };

      this.io
        .of('/offers')
        .to(`provider:${rawRow.assigned_provider_id}`)
        .emit('job:updated', providerPayload);
    }
  }
}