/**
 * Create / Edit Purchase Order screen — placeholder.
 * Full PO creation form (supplier picker, line items, MOQ validation)
 * will be implemented in a dedicated task.
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

export default function NewPOScreen() {
  const { editPoId } = useLocalSearchParams<{ editPoId?: string }>();
  const isEdit = Boolean(editPoId);

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.back} onPress={() => router.back()}>
        <Text style={styles.backText}>‹ Back</Text>
      </TouchableOpacity>
      <Text style={styles.title}>{isEdit ? 'Edit Purchase Order' : 'New Purchase Order'}</Text>
      <Text style={styles.subtitle}>PO creation form coming soon.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    paddingTop: 64,
    paddingHorizontal: 24,
    gap: 12,
  },
  back: { marginBottom: 8 },
  backText: { color: '#6366F1', fontSize: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 15, color: '#6B7280' },
});
