import { View, Text, StyleSheet } from 'react-native';

/**
 * Recommendations screen placeholder.
 * AI-driven reorder suggestions and feedback loop added in later phases.
 */
export default function RecommendationsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Recommendations</Text>
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
