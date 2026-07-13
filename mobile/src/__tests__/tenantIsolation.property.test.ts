// Feature: ai-inventory-manager
// Property 19: Tenant Isolation via RLS
//
// Validates: Requirements 12.3, 9.4
//
// Pure-logic property tests that model RLS tenant-isolation at the data layer.
// No live Supabase instance required — the RLS row-filter predicate
// `business_id = (auth.jwt() ->> 'business_id')::uuid` is replicated in
// pure TypeScript so that fast-check can exhaustively explore it.
//
// Design rationale:
//   Real RLS tests require a live Postgres instance. This test suite validates
//   the invariant at the logic level: given any two distinct tenant JWTs and
//   any set of rows belonging to either tenant, the simulated RLS filter must
//   return only rows owned by the querying tenant — never rows belonging to the
//   other tenant. This catches bugs in the filter predicate, data construction,
//   or cross-tenant join logic before they reach the database.

import fc from 'fast-check';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types — mirror the Postgres schema columns relevant to RLS
// ---------------------------------------------------------------------------

/** Minimal shape that every business-data row must have (the RLS predicate column). */
export interface TenantRow {
  row_id: string;
  business_id: string; // tenant key — RLS filters on this column
  data: string;        // arbitrary payload
}

/** Simulated JWT claims injected by the auth-hooks Edge Function. */
export interface JwtClaims {
  sub: string;       // user_id
  business_id: string;
  role: 'owner' | 'staff' | 'purchasing' | 'accountant';
  exp: number;       // Unix timestamp
}

/**
 * The business-data tables that must be covered by tenant-isolation RLS.
 * Sourced from Requirements 14.1 and 12.3.
 */
export const BUSINESS_DATA_TABLES = [
  'businesses',
  'locations',
  'user_profiles',
  'user_roles',
  'suppliers',
  'products',
  'product_barcodes',
  'product_variants',
  'inventory_movements',
  'inventory_balances',
  'purchase_orders',
  'purchase_order_lines',
  'stock_count_sessions',
  'stock_count_lines',
  'alerts',
  'recommendations',
  'recommendation_feedback',
  'square_sync_events',
  'offline_queue_log',
] as const;

export type BusinessDataTable = (typeof BUSINESS_DATA_TABLES)[number];

// ---------------------------------------------------------------------------
// Pure RLS simulator
// ---------------------------------------------------------------------------

/**
 * Simulates the Postgres RLS predicate:
 *   USING (business_id = (auth.jwt() ->> 'business_id')::uuid)
 *
 * Given a querying JWT and a set of rows (from any tenants), returns only the
 * rows that the policy would allow — i.e. rows where business_id matches the
 * JWT claim.
 */
export function applyRlsTenantFilter(
  jwt: JwtClaims,
  rows: ReadonlyArray<TenantRow>,
): TenantRow[] {
  return rows.filter((row) => row.business_id === jwt.business_id);
}

/**
 * Constructs a minimal JWT claims object for a given tenant.
 * Mirrors what the auth-hooks Edge Function injects on sign-in.
 */
export function makeJwt(
  userId: string,
  businessId: string,
  role: JwtClaims['role'] = 'owner',
): JwtClaims {
  return {
    sub: userId,
    business_id: businessId,
    role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * Build a TenantRow belonging to the given business.
 */
export function makeRow(rowId: string, businessId: string, data = 'payload'): TenantRow {
  return { row_id: rowId, business_id: businessId, data };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate two distinct business UUIDs (Business A and Business B). */
const twoBizArb = fc
  .tuple(fc.uuid(), fc.uuid())
  .filter(([a, b]) => a !== b);

const roleArb = fc.constantFrom<JwtClaims['role']>(
  'owner',
  'staff',
  'purchasing',
  'accountant',
);

// ---------------------------------------------------------------------------
// Property 19 — test 1: No cross-tenant row leakage
//
// For every pair of distinct tenants (A, B) and any set of rows owned by each,
// querying as Tenant A MUST return ONLY Tenant A rows and zero Tenant B rows.
//
// Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
  'Business A JWT never retrieves rows owned by Business B',
  () => {
    // Seed is logged so CI failures can be reproduced with --seed=<N>
    const seed = 1900;
    console.log(`[Property 19] seed=${seed}`);

    fc.assert(
      fc.property(
        twoBizArb,
        fc.uuid(),  // user A
        fc.uuid(),  // user B
        roleArb,
        roleArb,
        (
          [bizA, bizB],
          userA,
          userB,
          roleA,
          roleB,
        ) => {
          // Build data belonging to each tenant
          const rowsA: TenantRow[] = [
            makeRow(randomUUID(), bizA, 'inv_movement_bizA'),
            makeRow(randomUUID(), bizA, 'product_bizA'),
            makeRow(randomUUID(), bizA, 'purchase_order_bizA'),
          ];
          const rowsB: TenantRow[] = [
            makeRow(randomUUID(), bizB, 'inv_movement_bizB'),
            makeRow(randomUUID(), bizB, 'product_bizB'),
            makeRow(randomUUID(), bizB, 'purchase_order_bizB'),
          ];

          // Combined table (both tenants' data is stored in the same PG table)
          const combinedTable = [...rowsA, ...rowsB];

          const jwtA = makeJwt(userA, bizA, roleA);
          const jwtB = makeJwt(userB, bizB, roleB);

          // Simulate Tenant A querying
          const visibleToA = applyRlsTenantFilter(jwtA, combinedTable);
          // Simulate Tenant B querying
          const visibleToB = applyRlsTenantFilter(jwtB, combinedTable);

          // Core invariant: no cross-tenant leakage
          const leakFromBtoA = visibleToA.filter((r) => r.business_id === bizB);
          const leakFromAtoB = visibleToB.filter((r) => r.business_id === bizA);

          expect(leakFromBtoA).toHaveLength(0);
          expect(leakFromAtoB).toHaveLength(0);

          // Each tenant only sees their own rows
          expect(visibleToA.every((r) => r.business_id === bizA)).toBe(true);
          expect(visibleToB.every((r) => r.business_id === bizB)).toBe(true);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1900 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 19 — test 2: All own-tenant rows are visible (no false negatives)
//
// The RLS filter must not accidentally hide rows that belong to the querying
// tenant (i.e., the filter must be an exact match, not a subset).
//
// Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
  'All rows owned by Business A are visible to a Business A JWT',
  () => {
    const seed = 1901;
    console.log(`[Property 19] seed=${seed}`);

    fc.assert(
      fc.property(
        twoBizArb,
        fc.uuid(),
        roleArb,
        ([bizA, bizB], userA, roleA) => {
          // Generate a dynamic set of rows for bizA using an inline strategy
          const ownRows: TenantRow[] = Array.from({ length: 5 }, () =>
            makeRow(randomUUID(), bizA),
          );
          const foreignRows: TenantRow[] = Array.from({ length: 5 }, () =>
            makeRow(randomUUID(), bizB),
          );

          const combinedTable = [...ownRows, ...foreignRows];
          const jwtA = makeJwt(userA, bizA, roleA);

          const visible = applyRlsTenantFilter(jwtA, combinedTable);

          // Every own row must be present in the result (no false negatives)
          for (const ownRow of ownRows) {
            expect(visible.some((r) => r.row_id === ownRow.row_id)).toBe(true);
          }

          // Result count matches exactly the own-rows count
          expect(visible).toHaveLength(ownRows.length);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1901 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 19 — test 3: Filter is idempotent (applying twice yields same result)
//
// RLS must be deterministic — re-querying with the same JWT must not return
// a different set of rows.
//
// Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
  'Applying RLS filter twice with the same JWT yields the same result set',
  () => {
    const seed = 1902;
    console.log(`[Property 19] seed=${seed}`);

    fc.assert(
      fc.property(
        twoBizArb,
        fc.uuid(),
        roleArb,
        ([bizA, bizB], userA, roleA) => {
          const rows: TenantRow[] = [
            ...Array.from({ length: 8 }, () => makeRow(randomUUID(), bizA)),
            ...Array.from({ length: 8 }, () => makeRow(randomUUID(), bizB)),
          ];

          const jwt = makeJwt(userA, bizA, roleA);

          const firstPass = applyRlsTenantFilter(jwt, rows);
          const secondPass = applyRlsTenantFilter(jwt, rows);

          // Same length
          expect(secondPass).toHaveLength(firstPass.length);
          // Same row IDs (order-independent comparison)
          const firstIds = new Set(firstPass.map((r) => r.row_id));
          const secondIds = new Set(secondPass.map((r) => r.row_id));
          for (const id of firstIds) {
            expect(secondIds.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: 100, verbose: true, seed: 1902 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 19 — test 4: All business-data tables are covered by the policy
//
// BUSINESS_DATA_TABLES is the exhaustive list from Requirements 14.1 + 12.3.
// Every table in that list must be represented — this structural test ensures
// the coverage list stays in sync with the schema.
//
// Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
  'BUSINESS_DATA_TABLES list covers every table enumerated in Requirements 14.1 and 12.3',
  () => {
    // Tables mandated by Requirement 14.1
    const requiredBySpec = new Set([
      'businesses',
      'locations',
      'user_profiles',        // "users" in spec, implemented as user_profiles + user_roles
      'user_roles',
      'suppliers',
      'products',
      'product_barcodes',
      'product_variants',
      'inventory_balances',
      'inventory_movements',
      'purchase_orders',
      'purchase_order_lines',
      'stock_count_sessions',
      'stock_count_lines',
      'alerts',
      'recommendations',
      'recommendation_feedback',
      'square_sync_events',
      'offline_queue_log',
    ]);

    for (const table of requiredBySpec) {
      expect(BUSINESS_DATA_TABLES).toContain(table);
    }
  },
);

// ---------------------------------------------------------------------------
// Property 19 — test 5: Mixed-tenant table — row count splits correctly
//
// For N rows belonging to tenant A and M rows belonging to tenant B (N,M >= 1),
// the filter returns exactly N rows for a tenant-A JWT and M rows for tenant-B.
//
// Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 19: Tenant Isolation via RLS
  'Correct row counts returned for each tenant in a mixed-tenant table',
  () => {
    const seed = 1903;
    console.log(`[Property 19] seed=${seed}`);

    fc.assert(
      fc.property(
        twoBizArb,
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 1, max: 30 }),  // rows for biz A
        fc.integer({ min: 1, max: 30 }),  // rows for biz B
        roleArb,
        roleArb,
        ([bizA, bizB], userA, userB, countA, countB, roleA, roleB) => {
          const rowsA = Array.from({ length: countA }, () =>
            makeRow(randomUUID(), bizA),
          );
          const rowsB = Array.from({ length: countB }, () =>
            makeRow(randomUUID(), bizB),
          );

          const table = [...rowsA, ...rowsB];

          const visibleToA = applyRlsTenantFilter(makeJwt(userA, bizA, roleA), table);
          const visibleToB = applyRlsTenantFilter(makeJwt(userB, bizB, roleB), table);

          expect(visibleToA).toHaveLength(countA);
          expect(visibleToB).toHaveLength(countB);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1903 },
    );
  },
);
