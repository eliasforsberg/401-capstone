import { View, Text, StyleSheet } from 'react-native';

/**
 * Dashboard screen placeholder.
 * KPI cards, low-stock alerts, and AI recommendations added in later phases.
 */
export default function DashboardScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Dashboard</Text>
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
