/**
 * Inventory list screen — paginated stock-on-hand with search.
 *
 * Shows all active products with their current on-hand quantity.
 * Supports search by name or SKU, pull-to-refresh, and infinite scroll.
 *
 * Requirements: 4.4, 7.8
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useProducts } from '@/hooks/useProducts';
import type { Product } from '@/hooks/useProducts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ProductRowProps {
  item: Product & { quantity?: number };
  onPress: () => void;
}

function ProductRow({ item, onPress }: ProductRowProps) {
  const isLowStock =
    item.quantity !== undefined && item.quantity <= item.reorder_point;
  const isOutOfStock = item.quantity !== undefined && item.quantity <= 0;

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, SKU ${item.sku}, quantity ${item.quantity ?? '—'}`}
    >
      <View style={styles.rowInfo}>
        <Text style={styles.productName} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.productSku}>{item.sku}</Text>
        {item.category ? (
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryBadgeText}>{item.category}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <Text
          style={[
            styles.quantity,
            isOutOfStock && styles.quantityOutOfStock,
            !isOutOfStock && isLowStock && styles.quantityLow,
          ]}
        >
          {item.quantity ?? '—'}
        </Text>
        <Text style={styles.quantityLabel}>on hand</Text>
      </View>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function InventoryIndexScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, refetch } = useProducts({
    page,
    pageSize: PAGE_SIZE,
    search: search.trim() || undefined,
  });

  const products = data?.products ?? [];
  const hasMore = data ? page < data.totalPages : false;

  const handleLoadMore = useCallback(() => {
    if (!isFetching && hasMore) {
      setPage((p) => p + 1);
    }
  }, [isFetching, hasMore]);

  const handleSearch = useCallback((text: string) => {
    setSearch(text);
    setPage(1); // reset pagination on new search
  }, []);

  const handleRefresh = useCallback(() => {
    setPage(1);
    refetch();
  }, [refetch]);

  const handleRowPress = useCallback(
    (productId: string) => {
      router.push(`/(app)/inventory/${productId}`);
    },
    [router],
  );

  const handleScanPress = useCallback(() => {
    router.push('/(app)/inventory/scan');
  }, [router]);

  const renderItem = useCallback(
    ({ item }: { item: Product }) => (
      <ProductRow
        item={item}
        onPress={() => handleRowPress(item.product_id)}
      />
    ),
    [handleRowPress],
  );

  const renderFooter = useCallback(() => {
    if (!isFetching || page === 1) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color="#6366f1" />
      </View>
    );
  }, [isFetching, page]);

  const renderEmpty = useCallback(() => {
    if (isLoading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>
          {search.trim()
            ? `No products matching "${search}"`
            : 'No products found'}
        </Text>
      </View>
    );
  }, [isLoading, search]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Inventory</Text>
      </View>

      {/* Search bar */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or SKU…"
          placeholderTextColor="#9ca3af"
          value={search}
          onChangeText={handleSearch}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel="Search inventory"
          accessibilityHint="Filter products by name or SKU"
        />
      </View>

      {/* Column labels */}
      <View style={styles.columnHeader}>
        <Text style={styles.columnHeaderText}>Product</Text>
        <Text style={styles.columnHeaderText}>Qty</Text>
      </View>

      {/* Product list */}
      {isLoading && page === 1 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#6366f1" />
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.product_id}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={renderFooter}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          onRefresh={handleRefresh}
          refreshing={isFetching && page === 1}
          contentContainerStyle={
            products.length === 0 ? styles.listEmpty : undefined
          }
        />
      )}

      {/* Scan FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={handleScanPress}
        accessibilityRole="button"
        accessibilityLabel="Scan barcode"
      >
        <Text style={styles.fabIcon}>⬡</Text>
        <Text style={styles.fabLabel}>Scan</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  header: {
    paddingTop: 60,
    paddingBottom: 12,
    paddingHorizontal: 16,
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
  },
  searchContainer: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  searchInput: {
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
  },
  columnHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#f3f4f6',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  columnHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  rowInfo: {
    flex: 1,
    marginRight: 12,
  },
  productName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 2,
  },
  productSku: {
    fontSize: 13,
    color: '#6b7280',
    marginBottom: 4,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#ede9fe',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  categoryBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#7c3aed',
    textTransform: 'capitalize',
  },
  rowRight: {
    alignItems: 'flex-end',
    minWidth: 48,
  },
  quantity: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  quantityLow: {
    color: '#d97706',
  },
  quantityOutOfStock: {
    color: '#dc2626',
  },
  quantityLabel: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerLoader: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 15,
    color: '#6b7280',
    textAlign: 'center',
  },
  listEmpty: {
    flexGrow: 1,
  },
  fab: {
    position: 'absolute',
    bottom: 32,
    right: 24,
    backgroundColor: '#6366f1',
    borderRadius: 28,
    width: 72,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  fabIcon: {
    fontSize: 18,
    color: '#ffffff',
    lineHeight: 22,
  },
  fabLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ffffff',
    marginTop: 1,
  },
});
