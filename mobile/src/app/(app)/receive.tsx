import { View, Text, StyleSheet } from 'react-native';

/**
 * Receive screen placeholder.
 * PO selection and ad hoc receive workflow added in task 15.
 */
export default function ReceiveScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Receive</Text>
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
