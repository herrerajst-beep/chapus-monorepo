import { io, type Socket } from 'socket.io-client';
import {
  NAMESPACES,
  type BookingsClientEvents,
  type BookingsServerEvents,
  type OffersServerEvents,
} from '@chapus/core';

export type OffersSocket = Socket<OffersServerEvents, Record<string, never>>;
export type BookingsSocket = Socket<BookingsServerEvents, BookingsClientEvents>;

/**
 * Ambos namespaces comparten una única conexión física (Manager de socket.io por URL).
 * El JWT viaja en `auth.token` y se pide de nuevo en cada (re)conexión, así un token
 * renovado (con kycStatus actualizado) se usa sin recrear el socket.
 */
function connect<T extends Socket>(url: string, namespace: string, getToken: () => Promise<string | null>): T {
  return io(`${url}${namespace}`, {
    transports: ['websocket'],
    autoConnect: false,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
    auth: (cb) => {
      getToken().then((token) => cb({ token }));
    },
  }) as T;
}

export const createOffersSocket = (url: string, getToken: () => Promise<string | null>) =>
  connect<OffersSocket>(url, NAMESPACES.offers, getToken);

export const createBookingsSocket = (url: string, getToken: () => Promise<string | null>) =>
  connect<BookingsSocket>(url, NAMESPACES.bookings, getToken);
