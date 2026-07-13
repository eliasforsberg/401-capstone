/**
 * TanStack Query v5 hooks for inventory balances and movement history.
 *
 * All queries are scoped to the authenticated user's businessId (read from
 * the Zustand auth store).
 *
 * Requirements: 1.2, 1.4
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getBalance,
  getMovementHistory,
  insertMovement,
} from '@/lib/inventoryService';
import type { InsertMovementParams } from '@/lib/inventoryService';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { GetMovementHistoryOptions } from '@/lib/inventoryService';

// Re-export for consumers who need the options type
export type { GetMovementHistoryOptions };

// ---------------------------------------------------------------------------
// TypeScript interfaces
// ---------------------------------------------------------------------------

/** Mirrors the `products` table columns needed for the stock-on-hand join. */
export interface Product {
  product_id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unit_of_measure: string;
  reorder_point: number;
  reorder_quantity: number;
  safety_stock: number;
  cost_price: number | null;
  selling_price: number | null;
  is_active: boolean;
}

/** Result shape returned by `useStockOnHand`. */
export interface StockOnHandItem {
  product: Product;
  balance: number;
  locationId: string;
}

// ---------------------------------------------------------------------------
// Query key factories
// ---------------------------------------------------------------------------

/** `['balance', skuId, locationId]` */
const balanceKey = (skuId: string, locationId: string) =>
  ['balance', skuId, locationId] as const;

/** `['movements', skuId, opts]` */
const movementsKey = (skuId: string, opts?: GetMovementHistoryOptions) =>
  ['movements', skuId, opts] as const;

/** `['stock-on-hand', businessId]` */
const stockOnHandKey = (businessId: string) =>
  ['stock-on-hand', businessId] as const;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Current on-hand balance for a single SKU at a specific location.
 *
 * Requirements: 1.2
 */
export function useBalance(skuId: string, locationId: string) {
  return useQuery({
    queryKey: balanceKey(skuId, locationId),
    queryFn: () => getBalance(skuId, locationId),
    enabled: Boolean(skuId) && Boolean(locationId),
  });
}

/**
 * Movement history for a single SKU, ordered newest-first.
 * Optional `opts` allow filtering by location, movement type, and pagination.
 *
 * Requirements: 1.4
 */
export function useMovementHistory(
  skuId: string,
  opts?: GetMovementHistoryOptions,
) {
  return useQuery({
    queryKey: movementsKey(skuId, opts),
    queryFn: () => getMovementHistory(skuId, opts ?? {}),
    enabled: Boolean(skuId),
  });
}

/**
 * Full stock-on-hand list: all `inventory_balances` joined with `products`
 * for the current business, ordered by balance ascending (low stock first).
 *
 * Requirements: 1.2, 4.4
 */
export function useStockOnHand() {
  const businessId = useAuthStore((s) => s.businessId);

  return useQuery({
    queryKey: stockOnHandKey(businessId ?? ''),
    queryFn: async (): Promise<StockOnHandItem[]> => {
      if (!businessId) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('inventory_balances')
        .select(
          `quantity,
           location_id,
           sku_id,
           products!inner(
             product_id,
             sku,
             name,
             description,
             category,
             unit_of_measure,
             reorder_point,
             reorder_quantity,
             safety_stock,
             cost_price,
             selling_price,
             is_active
           )`,
        )
        .eq('business_id', businessId)
        .eq('products.is_active', true)
        .order('quantity', { ascending: true });

      if (error) throw error;

      return ((data ?? []) as any[]).map((row) => ({
        product: row.products as Product,
        balance: Number(row.quantity),
        locationId: row.location_id as string,
      }));
    },
    enabled: Boolean(businessId),
  });
}

/**
 * Mutation that inserts an inventory movement with optimistic balance updates.
 *
 * Optimistic update strategy:
 *   - `onMutate`: immediately increment the cached balance by `quantity_delta`
 *     so the UI reflects the change before the server responds.
 *   - `onError`: roll back to the previous balance snapshot captured in `onMutate`.
 *   - `onSettled`: invalidate balance, movement history, and stock-on-hand caches
 *     so they are refetched with the authoritative server values.
 *
 * Requirements: 1.2, 1.4
 */
export function useInsertMovement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: InsertMovementParams) => insertMovement(params),

    onMutate: async (params: InsertMovementParams) => {
      const key = balanceKey(params.sku_id, params.location_id);

      // Cancel any in-flight refetches to prevent them overwriting optimistic data
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot the previous balance value
      const previousBalance = queryClient.getQueryData<number>(key);

      // Optimistically update the balance
      queryClient.setQueryData<number>(key, (old) => {
        const current = old ?? 0;
        return current + params.quantity_delta;
      });

      // Return the snapshot so onError can roll back
      return { previousBalance, key };
    },

    onError: (
      _err,
      _params,
      context: { previousBalance: number | undefined; key: readonly unknown[] } | undefined,
    ) => {
      if (context) {
        // Roll back to the value captured before the optimistic update
        queryClient.setQueryData(context.key, context.previousBalance);
      }
    },

    onSettled: (_data, _err, params) => {
      // Invalidate all caches that may be affected by this movement
      void queryClient.invalidateQueries({
        queryKey: ['balance', params.sku_id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['movements', params.sku_id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['stock-on-hand'],
      });
    },
  });
}
