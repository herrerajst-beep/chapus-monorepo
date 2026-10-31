// packages/backend/src/modules/realtime/realtime.gateway.ts
import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

export interface ChapusJwtPayload {
  sub: string; // userId
  role: 'CLIENT' | 'PROVIDER' | 'DUAL';
  kycStatus: 'UNVERIFIED' | 'PENDING_VERIFICATION' | 'VERIFIED' | 'RESTRICTED';
  stripeAccountId: string | null;
}

export class RealtimeGateway {
  constructor(private readonly io: SocketServer) {
    this.setupOffersNamespace();
    this.setupClientBookingsNamespace();
  }

  /**
   * Namespace /offers -> Exclusivo para Proveedores recibiendo alertas geoespaciales
   */
  private setupOffersNamespace() {
    const offersNsp = this.io.of('/offers');

    offersNsp.use((socket: Socket, next) => {
      try {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
        if (!token) {
          const err: any = new Error('UNAUTHORIZED_MISSING_TOKEN');
          err.data = { statusCode: 401, errorCode: 'UNAUTHORIZED' };
          return next(err);
        }

        const payload = jwt.verify(token, process.env.JWT_SECRET!) as ChapusJwtPayload;

        // BLOQUEO ESTRICTO DE KYC: Si el autónomo no tiene el DNI/NIE verificado en Stripe,
        // bloqueamos su suscripción al stream de ofertas devolviendo 403.
        if (payload.kycStatus !== 'VERIFIED') {
          const err: any = new Error('Forbidden: KYC verification required to receive job offers');
          err.data = {
            statusCode: 403,
            errorCode: 'KYC_VERIFICATION_REQUIRED',
            kycStatus: payload.kycStatus,
          };
          return next(err);
        }

        socket.data.user = payload;
        return next();
      } catch (e) {
        const err: any = new Error('INVALID_TOKEN');
        err.data = { statusCode: 401, errorCode: 'INVALID_TOKEN' };
        return next(err);
      }
    });

    offersNsp.on('connection', (socket: Socket) => {
      const providerId = socket.data.user.sub;
      // Unimos al proveedor a su sala personal (soporta múltiples dispositivos sin colisión)
      socket.join(`provider:${providerId}`);
    });
  }

  /**
   * Namespace /bookings -> Para que el Cliente reciba actualizaciones en vivo de su solicitud
   */
  private setupClientBookingsNamespace() {
    const bookingsNsp = this.io.of('/bookings');

    bookingsNsp.use((socket: Socket, next) => {
      try {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET!) as ChapusJwtPayload;
        socket.data.user = payload;
        return next();
      } catch {
        const err: any = new Error('UNAUTHORIZED');
        err.data = { statusCode: 401, errorCode: 'UNAUTHORIZED' };
        return next(err);
      }
    });

    bookingsNsp.on('connection', (socket: Socket) => {
      // El cliente se suscribe a la sala de su solicitud activa: ej. request:uuid
      socket.on('request:subscribe', (requestId: string, callback?: (ack: { ok: boolean }) => void) => {
        socket.join(`request:${requestId}`);
        callback?.({ ok: true });
      });
    });
  }

  // =========================================================================
  // EMISORES DE EVENTOS EN TIEMPO REAL PARA EL CLIENTE (Punto 3)
  // =========================================================================

  /**
   * 1. Emitido cuando cambia el estado de la solicitud (ej. un profesional captura una
   * limpieza exprés en Fast-Match pasando a ASSIGNED, o inicia el servicio IN_PROGRESS).
   */
  public emitRequestUpdated(requestId: string, updatedRequest: any) {
    this.io.of('/bookings').to(`request:${requestId}`).emit('request:updated', {
      request: updatedRequest,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 2. Emitido en el modelo BIDDING cada vez que un autónomo envía una nueva cotización.
   */
  public emitBidCreated(requestId: string, newBid: any) {
    this.io.of('/bookings').to(`request:${requestId}`).emit('request:bid_created', {
      requestId,
      bid: newBid,
    });
  }
}