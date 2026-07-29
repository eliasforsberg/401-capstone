import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { Keyboard, Pressable, StyleSheet } from 'react-native';

import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// QueryClient singleton — created once for the lifetime of the app.
// ---------------------------------------------------------------------------
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry once on failure; stale time of 60 s to reduce redundant fetches.
      retry: 1,
      staleTime: 60_000,
    },
  },
});

// ---------------------------------------------------------------------------
// Inner layout component — must be inside QueryClientProvider so hooks work.
// ---------------------------------------------------------------------------
function AppLayout() {
  const initialize = useAuthStore((state) => state.initialize);

  useEffect(() => {
    // Restore persisted session from MMKV and subscribe to auth state changes.
    void initialize();
  }, [initialize]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Root layout — wraps the entire app in QueryClientProvider.
// ---------------------------------------------------------------------------
export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Pressable
        style={styles.flex}
        onPress={Keyboard.dismiss}
        accessible={false}
      >
        <AppLayout />
      </Pressable>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
