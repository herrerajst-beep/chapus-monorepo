import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { create } from 'zustand';
import { isApiError } from '@chapus/api';
import { socketErrorData, type GeoPoint } from '@chapus/core';
import { api, isDemoSession, offersSocket, session } from '@/lib/api';
import { getNativePushToken } from '@/features/alerts/notifications';
import {
  ensureBackgroundLocation,
  ensureForegroundLocation,
  ensureNotifications,
} from '@/features/permissions/primers';
import { startBackgroundLocation, stopBackgroundLocation } from './backgroundLocation';

const HEARTBEAT_MS = 30_000;
const MIN_MOVE_METERS = 75;

export type PresenceError = 'LOCATION_DENIED' | 'HEARTBEAT_FAILED' | 'KYC_REQUIRED' | null;

interface PresenceState {
  online: boolean;
  /** WebSocket /offers aceptado por el servidor (handshake con KYC VERIFIED). */
  streaming: boolean;
  position: GeoPoint | null;
  error: PresenceError;
  /** Rechazó las notificaciones: no recibirá trabajos con la app cerrada. */
  notificationsOff: boolean;
  /** Seguimiento de ubicación en segundo plano activo (servicio en primer plano en Android). */
  background: boolean;
  /** Causa del último heartbeat fallido, para el panel de diagnóstico. */
  heartbeatError: string | null;
}

export const usePresenceStore = create<PresenceState>(() => ({
  online: false,
  streaming: false,
  position: null,
  error: null,
  notificationsOff: false,
  background: false,
  heartbeatError: null,
}));

let fcmToken: string | undefined;
let retriedAuth = false;

const beat = async (at: GeoPoint, isOnline: boolean) => {
  try {
    await api.heartbeat(at, isOnline, fcmToken);
    if (usePresenceStore.getState().error === 'HEARTBEAT_FAILED') {
      usePresenceStore.setState({ error: null, heartbeatError: null });
    }
  } catch (e) {
    const detail = isApiError(e) ? `HTTP ${e.status} ${e.errorCode ?? ''}`.trim() : String(e);
    console.warn('[heartbeat] fallo:', detail);
    usePresenceStore.setState({ error: 'HEARTBEAT_FAILED', heartbeatError: detail });
  }
};

// El middleware de /offers rechaza el handshake; socket.io no reintenta solo en ese caso.
offersSocket.on('connect', () => {
  retriedAuth = false;
  usePresenceStore.setState((s) => ({ streaming: true, error: s.error === 'KYC_REQUIRED' ? null : s.error }));
});
offersSocket.on('disconnect', () => usePresenceStore.setState({ streaming: false }));
offersSocket.on('connect_error', async (err) => {
  const data = socketErrorData(err);
  if (data?.statusCode === 403) {
    // Sigue online por push/heartbeat, pero sin stream de ofertas hasta verificar el DNI/NIE.
    usePresenceStore.setState({ streaming: false, error: 'KYC_REQUIRED' });
  } else if (data?.statusCode === 401 && !retriedAuth) {
    retriedAuth = true;
    if (await session.refreshNow()) offersSocket.connect();
  }
});

/** Disparado por el interruptor "Disponible": es el contexto que justifica los permisos. */
export async function goOnline() {
  if (!(await ensureForegroundLocation())) return usePresenceStore.setState({ error: 'LOCATION_DENIED' });
  // Sin avisos se puede trabajar con la app abierta; se avisa en el radar, no se bloquea.
  const notifications = await ensureNotifications();
  fcmToken = (await getNativePushToken()) ?? undefined;
  const { coords } = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const at = { lat: coords.latitude, lng: coords.longitude };
  usePresenceStore.setState({ position: at, online: true, error: null, notificationsOff: !notifications });
  // En demo no hay servidor de sockets: las alertas llegan desde el panel de diagnóstico.
  if (isDemoSession()) usePresenceStore.setState({ streaming: true });
  else offersSocket.connect();
  await beat(at, true);
}

export async function goOffline() {
  const { position } = usePresenceStore.getState();
  usePresenceStore.setState({ online: false, background: false, ...(isDemoSession() && { streaming: false }) });
  offersSocket.disconnect();
  await stopBackgroundLocation().catch(() => undefined);
  if (position) await beat(position, false);
}

/** Opt-in desde el radar. Devuelve false si el usuario no concede "Siempre". */
export async function enableBackground() {
  if (!(await ensureBackgroundLocation())) return false;
  await startBackgroundLocation();
  usePresenceStore.setState({ background: true });
  return true;
}

export async function disableBackground() {
  await stopBackgroundLocation();
  usePresenceStore.setState({ background: false });
}

/**
 * Tras completar el KYC: renueva el JWT para que el claim `kycStatus` sea VERIFIED y
 * reabre /offers si el profesional estaba disponible.
 */
export async function resumeAfterKyc() {
  await session.refreshNow();
  if (usePresenceStore.getState().online && !offersSocket.connected) offersSocket.connect();
}

/** Mantiene el seguimiento de posición y el heartbeat mientras esté online. Montar una vez. */
export function usePresenceTracking() {
  const online = usePresenceStore((s) => s.online);
  const last = useRef<GeoPoint | null>(null);

  useEffect(() => {
    if (!online) return;
    let sub: Location.LocationSubscription | undefined;
    let cancelled = false;
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, distanceInterval: MIN_MOVE_METERS },
      ({ coords }) => {
        const at = { lat: coords.latitude, lng: coords.longitude };
        last.current = at;
        usePresenceStore.setState({ position: at });
        void beat(at, true);
      },
    ).then((s) => (cancelled ? s.remove() : (sub = s)));
    const timer = setInterval(() => {
      const at = last.current ?? usePresenceStore.getState().position;
      if (at) void beat(at, true);
    }, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      sub?.remove();
      clearInterval(timer);
    };
  }, [online]);
}
