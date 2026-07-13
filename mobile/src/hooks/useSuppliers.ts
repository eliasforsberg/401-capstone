/**
 * TanStack Query v5 hooks for suppliers.
 *
 * All queries are scoped to the authenticated user's businessId (read from
 * the Zustand auth store). Mutations invalidate the relevant query keys so
 * downstream UI stays fresh automatically.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Query key constants
// ---------------------------------------------------------------------------

export const SUPPLIERS_QUERY_KEY = ['suppliers'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors the `suppliers` Postgres table schema. */
export interface Supplier {
  supplier_id: string;
  business_id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  lead_time_days: number;
  minimum_order_qty: number;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

export interface CreateSupplierInput {
  name: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  lead_time_days?: number;
  minimum_order_qty?: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Fetch all active suppliers for the current business.
 *
 * Requirements: 7.1
 */
export function useSuppliers() {
  const businessId = useAuthStore((s) => s.businessId);

  return useQuery({
    queryKey: SUPPLIERS_QUERY_KEY,
    queryFn: async () => {
      if (!businessId) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('suppliers')
        .select('*')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('name', { ascending: true });

      if (error) throw error;
      return (data ?? []) as Supplier[];
    },
    enabled: Boolean(businessId),
  });
}

/**
 * Mutation to INSERT a new supplier.
 * Invalidates the suppliers list on success.
 *
 * Requirements: 8.2
 */
export function useCreateSupplier() {
  const businessId = useAuthStore((s) => s.businessId);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSupplierInput) => {
      if (!businessId) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('suppliers')
        .insert({
          ...input,
          business_id: businessId,
        })
        .select()
        .single();

      if (error) throw error;
      return data as Supplier;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SUPPLIERS_QUERY_KEY });
    },
  });
}
