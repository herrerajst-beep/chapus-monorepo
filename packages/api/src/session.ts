import { createStore } from 'zustand/vanilla';
import type { AuthSession, UserProfile } from '@chapus/core';

/** Almacenamiento seguro inyectado por la app (expo-secure-store). */
export interface SecureStorage {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: UserProfile;
}

export interface SessionState {
  status: 'loading' | 'signedOut' | 'signedIn';
  session: StoredSession | null;
}

/** Margen para renovar antes de que caduque el JWT. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Sesión passwordless: guarda el par access/refresh y renueva el JWT de forma proactiva.
 * `refreshNow()` fuerza la renovación, p. ej. tras completar el KYC, para que el claim
 * `kycStatus` del token pase a VERIFIED y el namespace /offers acepte el handshake.
 */
export function createSessionStore(opts: {
  storageKey: string;
  storage: SecureStorage;
  refresh: (refreshToken: string) => Promise<AuthSession>;
}) {
  const store = createStore<SessionState>(() => ({ status: 'loading', session: null }));
  let inflight: Promise<string | null> | null = null;

  const persist = async (s: StoredSession | null) => {
    if (s) await opts.storage.set(opts.storageKey, JSON.stringify(s));
    else await opts.storage.remove(opts.storageKey);
    store.setState({ session: s, status: s ? 'signedIn' : 'signedOut' });
  };

  const signIn = (auth: AuthSession) =>
    persist({
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: Date.now() + auth.expiresIn * 1000,
      user: auth.user,
    });

  const signOut = () => persist(null);

  const refreshNow = (): Promise<string | null> => {
    const current = store.getState().session;
    if (!current) return Promise.resolve(null);
    // Una sola renovación en vuelo aunque varias peticiones la pidan a la vez.
    inflight ??= opts
      .refresh(current.refreshToken)
      .then(async (auth) => {
        await signIn(auth);
        return auth.accessToken;
      })
      .catch(async () => {
        await signOut();
        return null;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    store,
    signIn,
    signOut,
    refreshNow,
    hydrate: async () => {
      const raw = await opts.storage.get(opts.storageKey).catch(() => null);
      const s = raw ? (JSON.parse(raw) as StoredSession) : null;
      store.setState({ session: s, status: s ? 'signedIn' : 'signedOut' });
    },
    getAccessToken: async (): Promise<string | null> => {
      const s = store.getState().session;
      if (!s) return null;
      if (Date.now() < s.expiresAt - EXPIRY_SKEW_MS) return s.accessToken;
      return refreshNow();
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionStore>;
