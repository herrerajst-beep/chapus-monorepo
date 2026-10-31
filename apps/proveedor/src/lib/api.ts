import * as SecureStore from 'expo-secure-store';
import { QueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import {
  createChapusApi,
  createOffersSocket,
  createSessionStore,
  shouldRetry,
  type SessionState,
} from '@chapus/api';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/v1';
const WS_URL = process.env.EXPO_PUBLIC_WS_URL ?? 'http://localhost:4000';

export const session = createSessionStore({
  storageKey: 'chapus.pro.session',
  storage: { get: SecureStore.getItemAsync, set: SecureStore.setItemAsync, remove: SecureStore.deleteItemAsync },
  refresh: (refreshToken) => api.refresh(refreshToken),
});

export const useSession = <T>(selector: (s: SessionState) => T) => useStore(session.store, selector);

export const api = createChapusApi({
  baseUrl: API_URL,
  getToken: session.getAccessToken,
  onUnauthorized: () => void session.signOut(),
});

export const offersSocket = createOffersSocket(WS_URL, session.getAccessToken);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: shouldRetry, staleTime: 15_000 },
    mutations: { retry: false },
  },
});

session.store.subscribe((s, prev) => {
  if (prev.status === 'signedIn' && s.status === 'signedOut') {
    offersSocket.disconnect();
    queryClient.clear();
  }
});
