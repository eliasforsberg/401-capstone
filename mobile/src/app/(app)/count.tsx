import { View, Text, StyleSheet } from 'react-native';

/**
 * Count screen placeholder.
 * Cycle count and full audit workflow added in task 17.
 */
export default function CountScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Count</Text>
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
