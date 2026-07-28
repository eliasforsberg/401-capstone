/**
 * TanStack Query v5 hooks for the products catalog.
 *
 * All queries are scoped to the authenticated user's businessId (read from
 * the Zustand auth store). Mutations invalidate the relevant query keys so
 * downstream UI stays fresh automatically.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Query key constants
// ---------------------------------------------------------------------------

export const PRODUCTS_QUERY_KEY = ['products'] as const;
export const PRODUCT_QUERY_KEY = (productId: string) =>
  ['product', productId] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors the `products` Postgres table schema. */
export interface Product {
  product_id: string;
  business_id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unit_of_measure: string;
  default_supplier_id: string | null;
  reorder_point: number;
  reorder_quantity: number;
  safety_stock: number;
  lead_time_days: number | null;
  cost_price: number | null;
  selling_price: number | null;
  image_storage_path: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateProductInput {
  sku: string;
  name: string;
  description?: string;
  category?: string;
  unit_of_measure?: string;
  default_supplier_id?: string;
  reorder_point?: number;
  reorder_quantity?: number;
  safety_stock?: number;
  lead_time_days?: number;
  cost_price?: number;
  selling_price?: number;
  image_storage_path?: string;
}

export interface UpdateProductInput {
  productId: string;
  updates: Partial<Omit<CreateProductInput, 'sku'>> & {
    sku?: string;
    is_active?: boolean;
  };
}

export interface ProductsQueryOptions {
  /** 1-based page number (default: 1) */
  page?: number;
  pageSize?: number;
  /** Filter by product name, SKU, or description */
  search?: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Paginated list of products for the current business.
 *
 * Requirements: 7.1
 */
export function useProducts(opts: ProductsQueryOptions = {}) {
  const businessId = useAuthStore((s) => s.businessId);
  const { page = 1, pageSize = 20, search } = opts;

  return useQuery({
    queryKey: [...PRODUCTS_QUERY_KEY, { page, pageSize, search }],
    queryFn: async () => {
      if (!businessId) throw new Error('Not authenticated');

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;

      let query = supabase
        .from('products')
        .select('*', { count: 'exact' })
        .eq('business_id', businessId)
        .eq('is_active', true)
        .range(from, to)
        .order('name', { ascending: true });

      if (search) {
        query = query.or(
          `name.ilike.%${search}%,sku.ilike.%${search}%,description.ilike.%${search}%`,
        );
      }

      const { data, error, count } = await query;

      if (error) throw error;

      return {
        products: (data ?? []) as Product[],
        total: count ?? 0,
        page,
        pageSize,
        totalPages: Math.ceil((count ?? 0) / pageSize),
      };
    },
    enabled: Boolean(businessId),
  });
}

/**
 * Single product by ID.
 *
 * Requirements: 7.1
 */
export function useProduct(productId: string) {
  const businessId = useAuthStore((s) => s.businessId);

  return useQuery({
    queryKey: PRODUCT_QUERY_KEY(productId),
    queryFn: async () => {
      if (!businessId) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('product_id', productId)
        .eq('business_id', businessId)
        .single();

      if (error) throw error;
      return data as Product;
    },
    enabled: Boolean(businessId) && Boolean(productId),
  });
}

/**
 * Mutation to INSERT a new product.
 * After creation, seeds a zero-quantity inventory movement so the product
 * immediately appears in stock-on-hand views and dashboard KPIs.
 * Invalidates both product and stock-on-hand query caches on success.
 *
 * Requirements: 7.1, 8.2
 */
export function useCreateProduct() {
  const businessId = useAuthStore((s) => s.businessId);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateProductInput) => {
      if (!businessId) throw new Error('Not authenticated');

      // 1. Insert the product
      const { data, error } = await supabase
        .from('products')
        .insert({
          ...input,
          business_id: businessId,
        })
        .select()
        .single();

      if (error) throw error;
      const product = data as Product;

      // 2. Seed a zero-balance inventory movement so the product appears in
      //    inventory_balances (and thus in stock-on-hand / dashboard queries).
      try {
        const { data: locationData } = await supabase
          .from('locations')
          .select('location_id')
          .eq('business_id', businessId)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();

        if (locationData?.location_id) {
          await supabase.from('inventory_movements').insert({
            business_id: businessId,
            location_id: locationData.location_id,
            sku_id: product.product_id,
            quantity_delta: 0,
            movement_type: 'adjustment',
            source: 'system',
            notes: 'Initial zero-balance seed on product creation',
          });
        }
      } catch (seedErr) {
        // Non-fatal — product was created successfully; balance will appear
        // once the first real movement is recorded.
        console.warn('[useCreateProduct] Failed to seed initial balance:', seedErr);
      }

      return product;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['stock-on-hand', businessId] });
    },
  });
}

/**
 * Mutation to UPDATE an existing product.
 * Invalidates the product list and the specific product detail query.
 *
 * Requirements: 7.1, 8.2
 */
export function useUpdateProduct() {
  const businessId = useAuthStore((s) => s.businessId);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ productId, updates }: UpdateProductInput) => {
      if (!businessId) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('products')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('product_id', productId)
        .eq('business_id', businessId)
        .select()
        .single();

      if (error) throw error;
      return data as Product;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
      queryClient.invalidateQueries({
        queryKey: PRODUCT_QUERY_KEY(variables.productId),
      });
    },
  });
}
