import { View, Text, StyleSheet } from 'react-native';

/**
 * Reports screen placeholder.
 * Inventory valuation, movement history, and export features added in later phases.
 */
export default function ReportsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Reports</Text>
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
