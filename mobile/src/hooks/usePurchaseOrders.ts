/**
 * TanStack Query v5 hooks for Purchase Orders.
 *
 * Queries use the Supabase JS client directly (tenant-scoped via RLS + businessId).
 * Mutations call the Edge Functions: create-po, update-po, submit-po, cancel-po.
 *
 * Requirements: 8.1, 8.2, 8.3
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SUPABASE_URL } from '@/lib/constants';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { PurchaseOrderStatus } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PurchaseOrderLine {
  po_line_id: string;
  po_id: string;
  business_id: string;
  sku_id: string;
  ordered_quantity: number;
  received_quantity: number;
  unit_cost: number | null;
  status: 'pending' | 'partially_received' | 'received';
  rationale_text: string | null;
  created_at: string;
}

export interface PurchaseOrder {
  po_id: string;
  business_id: string;
  location_id: string;
  supplier_id: string;
  status: PurchaseOrderStatus;
  source: 'manual' | 'ai_suggested';
  submitted_at: string | null;
  submitted_by: string | null;
  expected_delivery: string | null;
  notes: string | null;
  attachment_paths: string[] | null;
  created_at: string;
  updated_at: string;
  lines?: PurchaseOrderLine[];
}

// ---------------------------------------------------------------------------
// Input types for mutations
// ---------------------------------------------------------------------------

export interface CreatePOLine {
  sku_id: string;
  ordered_quantity: number;
  unit_cost?: number;
  expected_delivery?: string;
}

export interface CreatePOInput {
  supplier_id: string;
  location_id: string;
  notes?: string;
  expected_delivery?: string;
  lines: CreatePOLine[];
}

export interface UpdatePOLine {
  sku_id: string;
  ordered_quantity: number;
  unit_cost?: number;
}

export interface UpdatePOInput {
  po_id: string;
  updates: {
    notes?: string;
    expected_delivery?: string;
    lines?: UpdatePOLine[];
  };
}

export interface SubmitPOInput {
  po_id: string;
}

export interface CancelPOInput {
  po_id: string;
}

// ---------------------------------------------------------------------------
// Query key factories
// ---------------------------------------------------------------------------

/** `['purchase-orders', businessId, { status }]` */
const purchaseOrdersKey = (businessId: string, status?: PurchaseOrderStatus) =>
  ['purchase-orders', businessId, { status }] as const;

/** `['purchase-order', poId]` */
const purchaseOrderKey = (poId: string) =>
  ['purchase-order', poId] as const;

// ---------------------------------------------------------------------------
// Edge Function helper
// ---------------------------------------------------------------------------

/**
 * Calls a Supabase Edge Function with the current user's Bearer token.
 * Throws on non-2xx responses.
 */
async function callEdgeFunction<T>(
  functionName: string,
  body: Record<string, unknown>,
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }

  const url = `${SUPABASE_URL}/functions/v1/${functionName}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error ?? `Edge Function ${functionName} returned ${response.status}`);
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * List POs for the current business, optionally filtered by status.
 *
 * Requirements: 8.2
 */
export function usePurchaseOrders(opts?: { status?: PurchaseOrderStatus }) {
  const businessId = useAuthStore((s) => s.businessId);

  return useQuery({
    queryKey: purchaseOrdersKey(businessId ?? '', opts?.status),
    queryFn: async (): Promise<PurchaseOrder[]> => {
      if (!businessId) throw new Error('Not authenticated');

      let query = supabase
        .from('purchase_orders')
        .select('*')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false });

      if (opts?.status) {
        query = query.eq('status', opts.status);
      }

      const { data, error } = await query;

      if (error) throw error;
      return (data ?? []) as PurchaseOrder[];
    },
    enabled: Boolean(businessId),
  });
}

/**
 * Single PO with its lines, fetched by ID.
 *
 * Requirements: 8.2, 8.3
 */
export function usePurchaseOrder(poId: string) {
  const businessId = useAuthStore((s) => s.businessId);

  return useQuery({
    queryKey: purchaseOrderKey(poId),
    queryFn: async (): Promise<PurchaseOrder> => {
      if (!businessId) throw new Error('Not authenticated');

      const { data: po, error: poError } = await supabase
        .from('purchase_orders')
        .select('*')
        .eq('po_id', poId)
        .eq('business_id', businessId)
        .single();

      if (poError) throw poError;

      const { data: lines, error: linesError } = await supabase
        .from('purchase_order_lines')
        .select('*')
        .eq('po_id', poId)
        .order('created_at', { ascending: true });

      if (linesError) throw linesError;

      return { ...(po as PurchaseOrder), lines: (lines ?? []) as PurchaseOrderLine[] };
    },
    enabled: Boolean(businessId) && Boolean(poId),
  });
}

/**
 * Mutation to create a new PO via the create-po Edge Function.
 * Invalidates the PO list on success.
 *
 * Requirements: 8.2
 */
export function useCreatePO() {
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.businessId);

  return useMutation({
    mutationFn: (input: CreatePOInput) =>
      callEdgeFunction<{ status: string; po: PurchaseOrder }>('create-po', input as unknown as Record<string, unknown>),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['purchase-orders', businessId ?? ''],
      });
    },
  });
}

/**
 * Mutation to update a draft PO via the update-po Edge Function.
 * Invalidates the PO list and the specific PO detail query on success.
 *
 * Requirements: 8.2, 8.3
 */
export function useUpdatePO() {
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.businessId);

  return useMutation({
    mutationFn: (input: UpdatePOInput) =>
      callEdgeFunction<{ status: string; po: PurchaseOrder }>('update-po', input as unknown as Record<string, unknown>),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['purchase-orders', businessId ?? ''],
      });
      void queryClient.invalidateQueries({
        queryKey: purchaseOrderKey(variables.po_id),
      });
    },
  });
}

/**
 * Mutation to submit a PO (draft → submitted) via the submit-po Edge Function.
 * Invalidates the PO list and the specific PO detail query on success.
 *
 * Requirements: 8.1, 8.3
 */
export function useSubmitPO() {
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.businessId);

  return useMutation({
    mutationFn: (input: SubmitPOInput) =>
      callEdgeFunction<{ status: string; po: PurchaseOrder }>('submit-po', input as unknown as Record<string, unknown>),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['purchase-orders', businessId ?? ''],
      });
      void queryClient.invalidateQueries({
        queryKey: purchaseOrderKey(variables.po_id),
      });
    },
  });
}

/**
 * Mutation to cancel a PO (draft|submitted → cancelled) via the cancel-po Edge Function.
 * Invalidates the PO list and the specific PO detail query on success.
 *
 * Requirements: 8.1
 */
export function useCancelPO() {
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.businessId);

  return useMutation({
    mutationFn: (input: CancelPOInput) =>
      callEdgeFunction<{ status: string; po: PurchaseOrder }>('cancel-po', input as unknown as Record<string, unknown>),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['purchase-orders', businessId ?? ''],
      });
      void queryClient.invalidateQueries({
        queryKey: purchaseOrderKey(variables.po_id),
      });
    },
  });
}
