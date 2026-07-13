import { View, Text, StyleSheet } from 'react-native';

/**
 * Login screen placeholder.
 * Full implementation with react-hook-form + zod + Supabase auth added in task 8.3.
 */
export default function LoginScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Login</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
});
