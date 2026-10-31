import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClientProvider } from '@tanstack/react-query';
import { ApiProvider } from '@chapus/api';
import { palette } from '@chapus/ui';
import { api, queryClient, session, useSession } from '@/lib/api';

export default function RootLayout() {
  const status = useSession((s) => s.status);

  useEffect(() => {
    void session.hydrate();
  }, []);

  if (status === 'loading') return null;
  const signedIn = status === 'signedIn';

  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerTintColor: palette.brand,
            contentStyle: { backgroundColor: palette.background },
          }}
        >
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="index" options={{ title: 'Chapus' }} />
            <Stack.Screen name="request/new" options={{ title: 'Nueva solicitud' }} />
            <Stack.Screen name="request/[id]" options={{ title: 'Tu solicitud', headerBackVisible: false }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="login" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
      </ApiProvider>
    </QueryClientProvider>
  );
}
