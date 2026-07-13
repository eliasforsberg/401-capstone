/**
 * Inventory Ledger Service
 *
 * Provides helper functions for interacting with the append-only inventory
 * movement ledger and the materialized inventory_balances table.
 *
 * Key design rules:
 * - `insertMovement` NEVER touches `inventory_balances` directly; the DB
 *   trigger `trg_update_balance` maintains that table atomically.
 * - For adjustment-type movements the service captures `before_quantity` and
 *   `after_quantity` snapshots (Requirements 5.3, 5.4).
 */

import { supabase as defaultSupabase } from '@/lib/supabase';
import type { MovementType, MovementSource } from '@/types';

// ---------------------------------------------------------------------------
// TypeScript interfaces
// ---------------------------------------------------------------------------

/** Full row shape of `inventory_movements` as returned from the DB. */
export interface InventoryMovement {
  movement_id: string;
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  movement_type: MovementType;
  reason_code: string | null;
  source: MovementSource;
  reference_id: string | null;
  user_id: string | null;
  edge_fn_id: string | null;
  notes: string | null;
  before_quantity: number | null;
  after_quantity: number | null;
  unit_cost: number | null;
  created_at: string;
}

/**
 * Parameters accepted by `insertMovement`.
 *
 * `before_quantity` and `after_quantity` are intentionally omitted — the
 * service computes them automatically for adjustment-type movements.
 */
export interface InsertMovementParams {
  // Required identifiers
  business_id: string;
  location_id: string;
  sku_id: string;

  // Required movement fields
  quantity_delta: number;
  movement_type: MovementType;
  source: MovementSource;

  // Optional fields
  reason_code?: string;
  notes?: string;
  reference_id?: string;
  user_id?: string;
  unit_cost?: number;
}

// ---------------------------------------------------------------------------
// Movement types that require before/after quantity snapshots (Req 5.3, 5.4)
// ---------------------------------------------------------------------------

const SNAPSHOT_MOVEMENT_TYPES: ReadonlySet<MovementType> = new Set([
  'adjustment',
  'count_correction',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a movement into the append-only `inventory_movements` ledger.
 *
 * For adjustment-type movements (`adjustment`, `count_correction`) the
 * function first reads the current balance so it can store `before_quantity`
 * and `after_quantity` snapshots on the row (Requirements 5.3 & 5.4).
 *
 * The function NEVER writes to `inventory_balances` — that is handled
 * atomically by the `trg_update_balance` Postgres trigger after each INSERT
 * (Requirements 1.2, 1.3).
 *
 * @param movement - Required and optional movement fields.
 * @param supabaseClient - Optional Supabase client override (useful for
 *   testing or when a service-role client is needed inside an Edge Function).
 * @returns The fully-hydrated `InventoryMovement` row as stored in the DB.
 */
export async function insertMovement(
  movement: InsertMovementParams,
  supabaseClient = defaultSupabase,
): Promise<InventoryMovement> {
  const row: Record<string, unknown> = {
    business_id: movement.business_id,
    location_id: movement.location_id,
    sku_id: movement.sku_id,
    quantity_delta: movement.quantity_delta,
    movement_type: movement.movement_type,
    source: movement.source,
  };

  // Optional fields — only include when provided so the DB default applies
  if (movement.reason_code !== undefined) row.reason_code = movement.reason_code;
  if (movement.notes !== undefined) row.notes = movement.notes;
  if (movement.reference_id !== undefined) row.reference_id = movement.reference_id;
  if (movement.user_id !== undefined) row.user_id = movement.user_id;
  if (movement.unit_cost !== undefined) row.unit_cost = movement.unit_cost;

  // For adjustment-type movements capture before/after snapshots (Req 5.3, 5.4)
  if (SNAPSHOT_MOVEMENT_TYPES.has(movement.movement_type)) {
    const beforeQty = await getBalance(
      movement.sku_id,
      movement.location_id,
      supabaseClient,
    );
    row.before_quantity = beforeQty;
    row.after_quantity = beforeQty + movement.quantity_delta;
  }

  const { data, error } = await supabaseClient
    .from('inventory_movements')
    .insert(row)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to insert movement: ${error.message}`);
  }

  return data as InventoryMovement;
}

/**
 * Read the current on-hand quantity for a SKU at a location from the
 * materialized `inventory_balances` table.
 *
 * Returns `0` when no balance row exists yet (i.e. no movements have been
 * recorded for this SKU/location combination).
 *
 * @param skuId - UUID of the product (maps to `products.product_id`).
 * @param locationId - UUID of the location.
 * @param supabaseClient - Optional Supabase client override.
 */
export async function getBalance(
  skuId: string,
  locationId: string,
  supabaseClient = defaultSupabase,
): Promise<number> {
  const { data, error } = await supabaseClient
    .from('inventory_balances')
    .select('quantity')
    .eq('sku_id', skuId)
    .eq('location_id', locationId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read balance: ${error.message}`);
  }

  // No row means no movements have ever been recorded → balance is 0
  if (!data) return 0;

  return Number(data.quantity);
}

/**
 * Options for filtering and paginating movement history.
 */
export interface GetMovementHistoryOptions {
  /** Restrict results to a specific location. */
  locationId?: string;
  /** Maximum number of rows to return (default: no explicit limit applied). */
  limit?: number;
  /** Number of rows to skip for pagination. */
  offset?: number;
  /** Restrict results to a specific movement type. */
  movementType?: MovementType;
}

/**
 * Retrieve the movement history for a SKU, ordered newest-first.
 *
 * Optional filters allow narrowing by location, movement type, and
 * pagination (limit / offset).
 *
 * @param skuId - UUID of the product.
 * @param opts - Optional filter and pagination options.
 * @param supabaseClient - Optional Supabase client override.
 * @returns Array of `InventoryMovement` rows, newest first.
 */
export async function getMovementHistory(
  skuId: string,
  opts: GetMovementHistoryOptions = {},
  supabaseClient = defaultSupabase,
): Promise<InventoryMovement[]> {
  let query = supabaseClient
    .from('inventory_movements')
    .select('*')
    .eq('sku_id', skuId)
    .order('created_at', { ascending: false });

  if (opts.locationId !== undefined) {
    query = query.eq('location_id', opts.locationId);
  }

  if (opts.movementType !== undefined) {
    query = query.eq('movement_type', opts.movementType);
  }

  if (opts.limit !== undefined) {
    const start = opts.offset ?? 0;
    query = query.range(start, start + opts.limit - 1);
  } else if (opts.offset !== undefined) {
    // offset without limit — start from offset with no upper bound
    query = query.range(opts.offset, Number.MAX_SAFE_INTEGER);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch movement history: ${error.message}`);
  }

  return (data ?? []) as InventoryMovement[];
}
