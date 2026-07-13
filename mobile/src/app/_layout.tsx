import { Stack } from 'expo-router';

/**
 * Root layout — wraps all routes with a native navigation stack.
 * Auth state and providers will be added in task 8.
 */
export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    />
  );
}
