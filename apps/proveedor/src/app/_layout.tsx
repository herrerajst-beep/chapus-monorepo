import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClientProvider } from '@tanstack/react-query';
import { ApiProvider } from '@chapus/api';
import { palette } from '@chapus/ui';
import { api, queryClient, session, useSession } from '@/lib/api';
import { setupNotificationChannels } from '@/features/alerts/notifications';
import { useJobAlertChannel } from '@/features/alerts/useJobAlertChannel';
import { FastMatchBanner } from '@/features/alerts/FastMatchBanner';
import { usePresenceTracking } from '@/features/presence/usePresence';

function Realtime() {
  useJobAlertChannel();
  usePresenceTracking();
  return <FastMatchBanner />;
}

export default function RootLayout() {
  const status = useSession((s) => s.status);

  useEffect(() => {
    void session.hydrate();
    void setupNotificationChannels();
  }, []);

  if (status === 'loading') return null;
  const signedIn = status === 'signedIn';

  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerTintColor: palette.provider,
            contentStyle: { backgroundColor: palette.background },
          }}
        >
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="index" options={{ title: 'Chapus Pro' }} />
            <Stack.Screen name="alert/[id]" options={{ title: 'Nuevo trabajo', presentation: 'modal' }} />
            <Stack.Screen name="job/[id]" options={{ title: 'Trabajo asignado' }} />
            <Stack.Screen name="kyc" options={{ title: 'Verificación de identidad' }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="login" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
        {signedIn ? <Realtime /> : null}
      </ApiProvider>
    </QueryClientProvider>
  );
}
