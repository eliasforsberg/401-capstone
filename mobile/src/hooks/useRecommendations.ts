/**
 * TanStack Query v5 hooks for AI recommendations.
 *
 * Covers:
 *   - Fetching pending recommendations for the current business
 *   - Accepting a recommendation (updates status, inserts feedback, creates draft PO for reorder)
 *   - Rejecting a recommendation (updates status, inserts feedback with reason)
 *   - Manually triggering the ai-recommendations Edge Function
 *
 * Requirements: 11.1, 11.2, 11.3, 11.6, 11.7, 8.5, 8.8, 8.9
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SUPABASE_URL } from '@/lib/constants';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { RecommendationType, RecommendationStatus, ConfidenceLevel } from '@/types';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Recommendation {
  recommendation_id: string;
  business_id: string;
  recommendation_type: RecommendationType;
  sku_id: string | null;
  rationale_text: string;
  confidence_level: ConfidenceLevel;
  status: RecommendationStatus;
  suggested_quantity: number | null;
  created_at: string;
  expires_at: string;
  /** Joined from products table */
  product_name: string | null;
  product_sku: string | null;
  product_category: string | null;
  default_supplier_id: string | null;
}

export type RejectionReason =
  | 'already_ordered'
  | 'not_needed'
  | 'wrong_quantity'
  | 'other';

export interface AcceptRecommendationInput {
  recommendationId: string;
  skuId: string | null;
  suggestedQuantity: number | null;
  defaultSupplierId: string | null;
  /** Needed to create a draft PO line */
  recommendationType: RecommendationType;
}

export interface RejectRecommendationInput {
  recommendationId: string;
  rejectionReason: RejectionReason;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Query key factories
// ---------------------------------------------------------------------------

/** `['recommendations', businessId, statusFilter]` */
const recommendationsKey = (businessId: string, status: RecommendationStatus | 'pending') =>
  ['recommendations', businessId, status] as const;

// ---------------------------------------------------------------------------
// Edge Function helper (reused from usePurchaseOrders pattern)
// ---------------------------------------------------------------------------

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
// Query hook
// ---------------------------------------------------------------------------

/**
 * Fetch pending recommendations for the current business, joined with product
 * name/SKU/category for display purposes.
 */
export function useRecommendations() {
  const businessId = useAuthStore((s) => s.businessId);

  return useQuery({
    queryKey: recommendationsKey(businessId ?? '', 'pending'),
    queryFn: async (): Promise<Recommendation[]> => {
      if (!businessId) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('recommendations')
        .select(`
          recommendation_id,
          business_id,
          recommendation_type,
          sku_id,
          rationale_text,
          confidence_level,
          status,
          suggested_quantity,
          created_at,
          expires_at,
          products (
            name,
            sku,
            category,
            default_supplier_id
          )
        `)
        .eq('business_id', businessId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error) throw error;

      return ((data ?? []) as any[]).map((row) => ({
        recommendation_id: row.recommendation_id,
        business_id: row.business_id,
        recommendation_type: row.recommendation_type as RecommendationType,
        sku_id: row.sku_id ?? null,
        rationale_text: row.rationale_text,
        confidence_level: row.confidence_level as ConfidenceLevel,
        status: row.status as RecommendationStatus,
        suggested_quantity: row.suggested_quantity != null ? Number(row.suggested_quantity) : null,
        created_at: row.created_at,
        expires_at: row.expires_at,
        product_name: row.products?.name ?? null,
        product_sku: row.products?.sku ?? null,
        product_category: row.products?.category ?? null,
        default_supplier_id: row.products?.default_supplier_id ?? null,
      }));
    },
    enabled: Boolean(businessId),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Mutation: Accept recommendation
// ---------------------------------------------------------------------------

/**
 * Accept a recommendation:
 *   1. Update recommendation status → 'accepted'
 *   2. Insert recommendation_feedback row (action='accepted')
 *   3. If type === 'reorder': call create-po Edge Function to create a draft PO
 *
 * Requirements: 11.3, 8.5, 8.8
 */
export function useAcceptRecommendation() {
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.businessId);
  const user = useAuthStore((s) => s.user);

  return useMutation({
    mutationFn: async (input: AcceptRecommendationInput) => {
      if (!businessId || !user) throw new Error('Not authenticated');

      // 1. Update recommendation status
      const { error: updateError } = await supabase
        .from('recommendations')
        .update({ status: 'accepted' })
        .eq('recommendation_id', input.recommendationId)
        .eq('business_id', businessId);

      if (updateError) throw new Error(updateError.message);

      // 2. Insert feedback row
      const { error: feedbackError } = await supabase
        .from('recommendation_feedback')
        .insert({
          recommendation_id: input.recommendationId,
          business_id: businessId,
          user_id: user.id,
          action: 'accepted',
        });

      if (feedbackError) throw new Error(feedbackError.message);

      // 3. For reorder type: create a draft PO
      if (input.recommendationType === 'reorder' && input.skuId) {
        // We need a location_id and supplier_id to create a PO.
        // Fetch the first active location for this business and the default supplier.
        const { data: locationData } = await supabase
          .from('locations')
          .select('location_id')
          .eq('business_id', businessId)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();

        const locationId = locationData?.location_id;

        if (locationId && input.defaultSupplierId) {
          await callEdgeFunction('create-po', {
            supplier_id: input.defaultSupplierId,
            location_id: locationId,
            source: 'ai_suggested',
            notes: `Auto-generated from AI recommendation ${input.recommendationId}`,
            lines: [
              {
                sku_id: input.skuId,
                ordered_quantity: input.suggestedQuantity ?? 1,
                rationale_text: `AI reorder recommendation accepted`,
              },
            ],
          });
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['recommendations', businessId ?? ''],
      });
      void queryClient.invalidateQueries({
        queryKey: ['purchase-orders', businessId ?? ''],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Mutation: Reject recommendation
// ---------------------------------------------------------------------------

/**
 * Reject a recommendation:
 *   1. Update recommendation status → 'rejected'
 *   2. Insert recommendation_feedback row (action='rejected', rejection_reason)
 *
 * Requirements: 11.3, 8.9
 */
export function useRejectRecommendation() {
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.businessId);
  const user = useAuthStore((s) => s.user);

  return useMutation({
    mutationFn: async (input: RejectRecommendationInput) => {
      if (!businessId || !user) throw new Error('Not authenticated');

      // 1. Update recommendation status
      const { error: updateError } = await supabase
        .from('recommendations')
        .update({ status: 'rejected' })
        .eq('recommendation_id', input.recommendationId)
        .eq('business_id', businessId);

      if (updateError) throw new Error(updateError.message);

      // 2. Insert feedback row
      const { error: feedbackError } = await supabase
        .from('recommendation_feedback')
        .insert({
          recommendation_id: input.recommendationId,
          business_id: businessId,
          user_id: user.id,
          action: 'rejected',
          rejection_reason: input.rejectionReason,
          notes: input.notes ?? null,
        });

      if (feedbackError) throw new Error(feedbackError.message);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['recommendations', businessId ?? ''],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Mutation: Trigger AI analysis manually
// ---------------------------------------------------------------------------

/**
 * Manually trigger the ai-recommendations Edge Function.
 * Used by the "Run AI Analysis" button in the recommendations screen.
 *
 * Requirements: 11.1
 */
export function useRunAIAnalysis() {
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.businessId);

  return useMutation({
    mutationFn: () =>
      callEdgeFunction<{ ok: boolean; processed: number }>('ai-recommendations', {}),
    onSuccess: () => {
      // Refresh recommendations after the run
      void queryClient.invalidateQueries({
        queryKey: ['recommendations', businessId ?? ''],
      });
    },
  });
}
