import { Redirect } from 'expo-router';

/**
 * Root index — immediately redirect to the login screen.
 * Auth guard logic will be added in task 8.
 */
export default function Index() {
  return <Redirect href="/(auth)/login" />;
}
