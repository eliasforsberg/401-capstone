import { View, Text, StyleSheet } from 'react-native';

/**
 * Inventory screen placeholder.
 * Paginated stock-on-hand list with barcode scanner added in task 11.
 */
export default function InventoryScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Inventory</Text>
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
