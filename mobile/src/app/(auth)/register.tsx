import { View, Text, StyleSheet } from 'react-native';

/**
 * Register screen placeholder.
 * Full implementation with react-hook-form + zod + Supabase sign-up added in task 8.3.
 */
export default function RegisterScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Register</Text>
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
