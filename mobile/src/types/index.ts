/**
 * Shared TypeScript types for the AI Inventory Manager mobile app.
 */

// ---------------------------------------------------------------------------
// Auth / RBAC
// ---------------------------------------------------------------------------

/** Roles that can be assigned to a user within a business. */
export type UserRole = 'owner' | 'staff' | 'purchasing' | 'accountant';

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** Movement types that can appear in the append-only inventory ledger. */
export type MovementType =
  | 'receive'
  | 'sale'
  | 'return'
  | 'adjustment'
  | 'count_correction'
  | 'transfer';

/** Reason codes for adjustment and count_correction movements. */
export type ReasonCode =
  | 'damage'
  | 'theft'
  | 'expiry'
  | 'counting_correction'
  | 'other';

/** Source of a ledger movement. */
export type MovementSource = 'pos_square' | 'manual' | 'system';

// ---------------------------------------------------------------------------
// Purchase Orders
// ---------------------------------------------------------------------------

export type PurchaseOrderStatus =
  | 'draft'
  | 'submitted'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export type PurchaseOrderSource = 'manual' | 'ai_suggested';

export type PurchaseOrderLineStatus =
  | 'pending'
  | 'partially_received'
  | 'received';

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertType = 'low_stock' | 'stockout' | 'anomaly' | 'square_unmatched';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved';

// ---------------------------------------------------------------------------
// Stock Counts
// ---------------------------------------------------------------------------

export type CountType = 'cycle_count' | 'full_audit';
export type CountSessionStatus = 'in_progress' | 'completed' | 'cancelled';

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export type RecommendationType =
  | 'reorder'
  | 'dead_stock'
  | 'count_priority'
  | 'anomaly';

export type RecommendationStatus = 'pending' | 'accepted' | 'rejected' | 'expired';
export type ConfidenceLevel = 'heuristic' | 'forecast';

// ---------------------------------------------------------------------------
// Offline Queue
// ---------------------------------------------------------------------------

/** A serialisable action queued locally while the device is offline. */
export interface OfflineAction {
  /** Client-generated UUID — doubles as the idempotency key sent to Edge Functions. */
  id: string;
  type: 'receive' | 'adjustment' | 'count_line' | 'sale_manual';
  payload: Record<string, unknown>;
  /** ISO 8601 timestamp of when the action was queued. */
  createdAt: string;
  retryCount: number;
  status: 'pending' | 'syncing' | 'failed';
}

// ---------------------------------------------------------------------------
// Cached product (local MMKV catalog cache)
// ---------------------------------------------------------------------------

export interface CachedProduct {
  productId: string;
  sku: string;
  name: string;
  barcodes: string[];
  balance: number;
  balanceSyncedAt: string; // ISO 8601
}
