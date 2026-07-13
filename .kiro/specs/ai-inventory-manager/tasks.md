# Implementation Plan: AI Inventory Manager

## Overview

A mobile-first inventory and purchasing platform for micro retail businesses, built on React Native (Expo) + Supabase. All inventory mutations flow through an append-only ledger; balances are derived values. Square integration runs exclusively through Edge Functions. The AI layer uses heuristics and Z-score statistics — no external ML service. Single store in MVP; schema is multi-tenant from day one.

**Technology stack**: TypeScript · Expo SDK (Expo Router, expo-camera) · Supabase (Postgres + Auth + Realtime + Storage + Edge Functions) · Zustand · TanStack Query v5 · react-native-mmkv · NativeWind · fast-check + Jest

---

## Legend

- 🟢 **MVP** — required for initial launch
- 🔵 **Phase 2** — post-MVP, architected now but not activated
- Tasks marked `*` are optional (tests/validation) and will not be auto-executed

---

## Tasks

### Phase 0: Project Foundation

- [x] 0. Bootstrap Expo project and configure monorepo structure 🟢
  - [x] 0.1 Initialize Expo managed-workflow project with TypeScript template
    - Run `npx create-expo-app` with `--template expo-template-blank-typescript`
    - Configure `tsconfig.json` (strict mode, path aliases `@/` → `src/`)
    - Add `.nvmrc` / `.node-version` for consistent Node version across team
    - _Requirements: 15.7_

  - [x] 0.2 Install and configure core dependencies
    - Install: `expo-router`, `expo-camera`, `react-native-mmkv`, `zustand`, `@tanstack/react-query`, `nativewind`, `react-hook-form`, `zod`, `@supabase/supabase-js`
    - Install dev tools: `jest`, `fast-check`, `@testing-library/react-native`, `ts-jest`
    - Pin all dependency versions; add `overrides`/`resolutions` for known peer conflicts
    - _Requirements: 15.7_

  - [x] 0.3 Configure Expo Router file-based routing skeleton
    - Create `src/app/(auth)/login.tsx` and `src/app/(auth)/register.tsx` (placeholder screens)
    - Create `src/app/(app)/_layout.tsx` with authenticated tab-bar layout
    - Create stub screen files for all top-level routes: `dashboard`, `inventory`, `receive`, `count`, `orders`, `recommendations`, `reports`
    - _Requirements: 15.7_

  - [ ]* 0.4 Set up Jest + fast-check property test harness
    - Configure `jest.config.ts` with `ts-jest` preset and module name mapper for `@/`
    - Install `fast-check`; write a smoke-test property to confirm harness works
    - Add `scripts.test` in `package.json`; add `--runInBand` flag for CI
    - _Requirements: Design Testing Strategy_

- [x] 1. Initialize Supabase project and local dev environment 🟢
  - [x] 1.1 Set up Supabase CLI and local stack
    - Run `supabase init` in repo root; commit `supabase/` directory
    - Add `supabase start` / `supabase stop` npm scripts
    - Document local stack URLs in `README.md` (Studio, API, DB)
    - _Requirements: 14.4_

  - [x] 1.2 Configure GitHub Actions CI skeleton
    - Create `.github/workflows/ci.yml`: install deps → type-check → lint → unit tests
    - Add `supabase/migrations/` artifact caching step
    - Add branch protection rule comment in `README.md` (main branch requires CI pass)
    - _Requirements: 14.4_


---

### Phase 1: Supabase Schema, Migrations, RLS, and Seed Data

- [x] 2. Create core tenant and user migration 🟢
  - [x] 2.1 Write migration: tenant and user tables
    - Create `supabase/migrations/<timestamp>_01_tenant_users.sql`
    - Tables: `businesses`, `locations`, `user_profiles`, `user_roles`
    - Include UUID PKs, FK constraints, `created_at`/`updated_at` defaults
    - _Requirements: 14.1, 14.6_

  - [ ]* 2.2 Write RLS policies for tenant/user tables
    - Enable RLS on `businesses`, `locations`, `user_profiles`, `user_roles`
    - Policy: all SELECT/INSERT/UPDATE gated on `business_id = (auth.jwt() ->> 'business_id')::uuid`
    - Additional policy: only `owner` role can INSERT/UPDATE `user_roles`
    - _Requirements: 9.4, 12.3, 14.2_

- [x] 3. Write migration: product catalog tables 🟢
  - [x] 3.1 Create product catalog migration
    - Create `supabase/migrations/<timestamp>_02_product_catalog.sql`
    - Tables: `suppliers`, `products`, `product_barcodes`, `product_variants`
    - Include `UNIQUE (business_id, sku)` on products; `UNIQUE (business_id, barcode_value)` on product_barcodes
    - Add index `idx_barcodes_lookup` on `(business_id, barcode_value)`
    - _Requirements: 7.5, 14.1, 14.7_

  - [ ]* 3.2 Write RLS policies for product catalog tables
    - Enable RLS; add tenant isolation policies for all four catalog tables
    - Add role-gate INSERT/UPDATE on `products`, `product_barcodes`, `product_variants`: requires `owner` or `purchasing`
    - _Requirements: 9.2, 9.4, 14.2_

- [x] 4. Write migration: inventory ledger and balances 🟢
  - [x] 4.1 Create ledger migration
    - Create `supabase/migrations/<timestamp>_03_inventory_ledger.sql`
    - Tables: `inventory_movements` (append-only), `inventory_balances`
    - Add indexes: `idx_movements_sku_location`, `idx_movements_reference`, `idx_movements_type_source`
    - _Requirements: 1.1, 14.1, 14.7_

  - [x] 4.2 Implement ledger triggers and consistency function
    - Create `prevent_movement_mutation()` trigger (blocks UPDATE/DELETE on `inventory_movements`)
    - Create `update_inventory_balance()` AFTER INSERT trigger (updates materialized balance atomically)
    - Implement weighted average cost recalculation inside `update_inventory_balance()` for `movement_type = 'receive'`
    - Create `get_inventory_balance(sku_id, location_id)` Postgres function
    - _Requirements: 1.2, 1.3, 1.5, 10.7_

  - [ ]* 4.3 Write RLS policies for ledger tables
    - Enable RLS on `inventory_movements` and `inventory_balances`
    - Tenant isolation policy for SELECT/INSERT; explicit `USING (false)` policies for UPDATE and DELETE on `inventory_movements`
    - Role-gate INSERT: requires `owner`, `staff`, or `purchasing`; accountant SELECT only
    - _Requirements: 1.5, 9.2, 9.4_

  - [ ]* 4.4 Write property test for ledger-balance consistency invariant (Property 2)
    - **Property 2: Ledger-Balance Consistency Invariant**
    - Generate arbitrary arrays of movement deltas; apply via `applyMovementsToBalance()` helper; assert `balance === SUM(quantity_delta)`
    - **Validates: Requirements 1.2, 1.3, 1.7**

  - [ ]* 4.5 Write property test for movement field completeness (Property 1)
    - **Property 1: Movement Field Completeness**
    - Generate arbitrary movement inputs; assert all required fields are non-null in the resulting row
    - **Validates: Requirements 1.1, 1.6**

- [x] 5. Write migration: purchase orders and stock counts 🟢
  - [x] 5.1 Create PO and stock count migration
    - Create `supabase/migrations/<timestamp>_04_purchase_orders.sql`
    - Tables: `purchase_orders`, `purchase_order_lines`
    - Create `supabase/migrations/<timestamp>_05_stock_counts.sql`
    - Tables: `stock_count_sessions`, `stock_count_lines`
    - Add index `idx_po_status` on `purchase_orders(business_id, status)`
    - _Requirements: 14.1, 14.7_

  - [ ]* 5.2 Write RLS policies for PO and stock count tables
    - Tenant isolation on all four tables
    - INSERT/UPDATE on `purchase_orders`: requires `owner` or `purchasing`
    - INSERT on `stock_count_sessions`/`stock_count_lines`: requires `owner`, `staff`, or `purchasing`
    - _Requirements: 9.2, 9.4_

- [x] 6. Write migration: alerts, Square events, AI, and offline queue 🟢
  - [x] 6.1 Create remaining table migrations
    - Create `supabase/migrations/<timestamp>_06_alerts.sql`: `alerts` table
    - Create `supabase/migrations/<timestamp>_07_square_events.sql`: `square_sync_events` with `UNIQUE (square_event_id)`; index `idx_square_event_id`
    - Create `supabase/migrations/<timestamp>_08_ai_recommendations.sql`: `recommendations`, `recommendation_feedback`
    - Create `supabase/migrations/<timestamp>_09_offline_queue_log.sql`: `offline_queue_log` with `UNIQUE (idempotency_key)`
    - Add index `idx_alerts_active`, `idx_recommendations_pending`
    - _Requirements: 14.1, 14.7_

  - [ ]* 6.2 Write RLS policies for alerts, Square, AI, and queue tables
    - Tenant isolation on all new tables
    - `square_sync_events`: SELECT/UPDATE restricted to `owner`; no mobile client writes
    - `recommendations`: SELECT for `owner` and `purchasing`; INSERT/UPDATE for system (service role only)
    - _Requirements: 9.2, 9.4_

- [x] 7. Create seed data for development and QA 🟢
  - [x] 7.1 Write convenience-store seed fixture
    - Create `supabase/seed.sql`: 1 business, 1 location, 2 suppliers (e.g., "Metro Wholesale", "Snack Distributors")
    - 20+ SKUs across categories (beverages, snacks, tobacco, household); each with barcode, reorder_point, safety_stock, lead_time
    - 30 days of `inventory_movements` (receive, sale, adjustment entries) seeded programmatically via SQL loop or explicit inserts
    - 1 sample submitted PO with 3 PO lines; 2 resolved and 1 active alert
    - _Requirements: 14.5_

  - [ ]* 7.2 Validate seed data integrity
    - Write a Jest integration test that runs seed against local Supabase, then calls `get_inventory_balance()` for each SKU and asserts it matches `inventory_balances`
    - Assert at least 20 SKUs, 2 suppliers, movements spanning ≥ 30 days
    - _Requirements: 14.3, 14.5_


---

### Phase 2: Auth and User Management

- [x] 8. Implement Supabase Auth integration and JWT hook 🟢
  - [x] 8.1 Create `auth-hooks` Edge Function
    - Scaffold `supabase/functions/auth-hooks/index.ts`
    - Register as `custom_access_token` hook in Supabase Auth settings
    - On sign-in: query `user_roles` for the user's `business_id` and `role`; inject both into JWT claims
    - Return 401 if user has no `user_roles` entry (unregistered user)
    - _Requirements: 9.1, 12.2_

  - [x] 8.2 Implement Supabase client singleton and auth store
    - Create `src/lib/supabase.ts`: initialize `@supabase/supabase-js` with anon key and URL from env
    - Create `src/stores/authStore.ts` (Zustand): holds `session`, `user`, `businessId`, `role`
    - On session restore: read JWT claims to populate `businessId` and `role`
    - _Requirements: 12.1, 12.6_

  - [x] 8.3 Build login and register screens
    - `src/app/(auth)/login.tsx`: email/password form + magic link option using `react-hook-form` + `zod`
    - `src/app/(auth)/register.tsx`: creates `user_profiles` and `user_roles` rows after Supabase Auth sign-up
    - On success: navigate to `(app)/dashboard`
    - On sign-out: clear MMKV cache, clear Zustand stores, navigate to login
    - _Requirements: 12.1, 12.4, 12.6, 12.7_

  - [ ]* 8.4 Write integration test for JWT claim injection
    - Sign in with a seeded user via local Supabase; decode JWT; assert `business_id` and `role` claims are present and correct
    - Test that a user with no `user_roles` entry receives 401
    - _Requirements: 12.2_

- [x] 9. Implement user invitation and role management (Owner only) 🟢
  - [x] 9.1 Build invite user flow
    - Create `src/app/(app)/settings/invite.tsx`: email input + role selector (`staff`, `purchasing`, `accountant`)
    - Call Supabase Auth admin `inviteUserByEmail` via an Edge Function (never directly from client with service role)
    - Create `supabase/functions/invite-user/index.ts`: validates caller is `owner`, inserts pending `user_roles` row
    - _Requirements: 9.5_

  - [x] 9.2 Build remove user flow
    - `src/app/(app)/settings/team.tsx`: list team members with role; Owner can tap to remove
    - Edge Function `remove-user`: validates caller is `owner`, deletes `user_roles` row, calls Supabase Auth `admin.signOut` for all sessions
    - _Requirements: 9.6_


---

### Phase 3: Product Catalog and Barcode Management

- [x] 10. Implement product catalog data layer and hooks 🟢
  - [x] 10.1 Create TanStack Query hooks for products and suppliers
    - `src/hooks/useProducts.ts`: `useProducts()` (paginated list), `useProduct(productId)`, `useCreateProduct()`, `useUpdateProduct()`
    - `src/hooks/useSuppliers.ts`: `useSuppliers()`, `useCreateSupplier()`
    - All hooks use Supabase JS SDK; mutations invalidate relevant query keys
    - _Requirements: 7.1, 8.2_

  - [x] 10.2 Implement barcode resolution logic
    - `src/lib/barcodeResolver.ts`: given a barcode string, query `product_barcodes` joined to `products`; return the matched product or `null`
    - Implement local MMKV catalog cache: `CachedProduct` interface with `barcodes[]`, `balance`, `balanceSyncedAt`
    - Cache is loaded at app startup and on reconnect; barcode scan resolves against cache first, then falls back to network
    - _Requirements: 7.1, 7.2, 7.4, 13.3_

  - [ ]* 10.3 Write property test for barcode resolution uniqueness (Property 12)
    - **Property 12: Barcode Resolution Uniqueness**
    - Generate arbitrary sets of (barcode → productId) mappings; assert each barcode resolves to exactly one product; assert duplicate barcode assignment is rejected
    - **Validates: Requirements 7.2, 7.5**

- [x] 11. Build product catalog UI screens 🟢
  - [x] 11.1 Build product list and detail screens
    - `src/app/(app)/inventory/index.tsx`: paginated stock-on-hand list with search by name/SKU/barcode
    - `src/app/(app)/inventory/[skuId].tsx`: product detail showing balance, reorder settings, barcode list, recent movements
    - Allow Owner/Purchasing to edit reorder_point, reorder_quantity, safety_stock, lead_time_days, default_supplier_id
    - _Requirements: 4.4, 7.8_

  - [x] 11.2 Implement expo-camera barcode scanner component
    - `src/app/(app)/inventory/scan.tsx`: full-screen camera view with `expo-camera` barcode scanning
    - Support formats: UPC-A, UPC-E, EAN-13, EAN-8, Code 128, Code 39, QR Code, Data Matrix
    - On successful scan: resolve product within 1 second; navigate to product detail or prompt to create new product
    - Manual lookup fallback: text input for name/SKU/partial barcode search
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 15.2_

  - [x] 11.3 Implement product creation and barcode assignment flow
    - Form: SKU, name, category, unit_of_measure, reorder settings, default_supplier_id
    - Barcode assignment: scan or manually enter; enforce uniqueness within business (show conflict message if duplicate)
    - Supabase Storage upload for product image
    - _Requirements: 7.3, 7.5, 7.6, 7.8_

  - [ ]* 11.4 Write property test for variant multiplier expansion (Property 13)
    - **Property 13: Variant Multiplier Expansion**
    - Generate arbitrary (quantity, unit_multiplier) pairs; assert that `movement.quantity_delta === quantity * unit_multiplier`
    - **Validates: Requirements 7.7**


---

### Phase 4: Inventory Ledger Core

- [x] 12. Implement ledger write service and balance hooks 🟢
  - [x] 12.1 Create `inventoryService.ts` ledger write helpers
    - `src/lib/inventoryService.ts`: functions `insertMovement(movement)`, `getBalance(skuId, locationId)`, `getMovementHistory(skuId, opts)`
    - `insertMovement` must never directly update `inventory_balances`; the DB trigger handles balance update
    - Include `before_quantity` / `after_quantity` snapshots for adjustment-type movements
    - _Requirements: 1.1, 1.2, 1.3, 5.3, 5.4_

  - [x] 12.2 Create TanStack Query hooks for inventory
    - `src/hooks/useInventory.ts`: `useBalance(skuId)`, `useMovementHistory(skuId)`, `useStockOnHand()` (full list with balances)
    - Optimistic balance update on movement insert; roll back on error
    - _Requirements: 1.2, 1.4_

  - [ ]* 12.3 Write integration test for append-only enforcement
    - Against local Supabase: attempt UPDATE and DELETE on `inventory_movements`; assert both return an exception
    - Verify `get_inventory_balance()` matches `inventory_balances.quantity` after a sequence of inserts
    - _Requirements: 1.5, 14.3_

  - [ ]* 12.4 Write RLS validation test for inventory_movements
    - Sign in as Business A user; attempt to SELECT movements where `business_id = Business B`; assert 0 rows returned
    - Sign in as `accountant` role; attempt INSERT on `inventory_movements`; assert RLS rejection
    - _Requirements: 9.2, 9.4, 12.3_

- [x] 13. Checkpoint — core ledger functional 🟢
  - Ensure migration applies cleanly via `supabase db push` against local stack
  - Ensure append-only trigger test passes
  - Ensure balance consistency property test passes
  - Ask the user if questions arise.


---

### Phase 5: Stock Receiving Workflow

- [x] 14. Implement stock receiving backend logic 🟢
  - [x] 14.1 Create receiving Edge Function
    - `supabase/functions/receive-stock/index.ts`: accepts `{ po_id?, lines: [{sku_id, received_qty, damaged_qty, unit_cost}], idempotency_key }`
    - Validate caller JWT; check `offline_queue_log` for duplicate idempotency key
    - For each line: INSERT `receive` movement; if `damaged_qty > 0`, INSERT `adjustment` movement with `reason_code = 'damage'`
    - Update `purchase_order_lines.received_quantity` and `status`; auto-set PO status to `received` when all lines done
    - On success: INSERT into `offline_queue_log` (status=processed)
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 14.2 Write property test for receive movement creation (Property 3)
    - **Property 3: Receive Creates Valid Movement**
    - Generate arbitrary `(received_qty, damaged_qty)` pairs where both ≥ 0; assert exactly one `receive` movement and at most one `damage` adjustment; assert net balance increment equals `received_qty - damaged_qty`
    - **Validates: Requirements 2.3, 2.5**

- [x] 15. Build receiving mobile UI 🟢
  - [x] 15.1 Build PO selection and ad hoc receive screens
    - `src/app/(app)/receive/index.tsx`: list open/partially-received POs; "Ad Hoc Receive" button
    - `src/app/(app)/receive/[poId].tsx`: show PO lines with ordered/received quantities; barcode scan per line
    - Pre-populate product name and expected quantity from PO_Line after barcode scan
    - _Requirements: 2.1, 2.2_

  - [x] 15.2 Implement offline queue for receive actions
    - On submit while offline: serialize action to `OfflineAction` struct, persist to MMKV via `offlineQueueStore`
    - Display "Pending sync" badge on the receive confirmation screen
    - Sync on reconnect via `syncStore.processPendingActions()` (FIFO order)
    - _Requirements: 2.8, 2.9, 13.2, 13.4_

  - [ ]* 15.3 Write unit tests for receive workflow edge cases
    - Test: partial receive (received_qty < ordered_qty) → PO_Line status = `partially_received`
    - Test: all lines received → PO status = `received`
    - Test: damaged_qty > received_qty → validation error (should be rejected)
    - _Requirements: 2.6, 2.7_


---

### Phase 6: Stock Adjustments and Audits / Cycle Counts

- [x] 16. Implement stock adjustment workflow 🟢
  - [x] 16.1 Create adjustment Edge Function
    - `supabase/functions/adjust-stock/index.ts`: accepts `{ sku_id, location_id, quantity_delta, reason_code, notes?, idempotency_key }`
    - Validate `reason_code` is in the allowed set; require non-empty `notes` when `reason_code = 'other'`
    - Read current balance snapshot for `before_quantity`; compute `after_quantity`
    - If business has configured approval threshold AND caller role is `staff` AND `ABS(quantity_delta) > threshold`: insert with `status = pending_approval`; do NOT insert into `inventory_movements`
    - Otherwise: INSERT adjustment movement immediately; record in `offline_queue_log`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 16.2 Build adjustment approval flow (Owner only)
    - `src/app/(app)/adjustments/pending.tsx`: list adjustments in `pending_approval` status
    - Owner approve → call `approve-adjustment` Edge Function → INSERT movement, update status to `approved`
    - Owner reject → call `reject-adjustment` Edge Function → update status to `rejected`, notify submitting user via alert INSERT
    - _Requirements: 5.7, 5.8_

  - [x] 16.3 Build adjustment mobile UI
    - `src/app/(app)/inventory/[skuId].tsx` (extend): "Adjust Stock" button opens modal with reason_code picker, quantity input, notes field
    - Show validation message when `reason_code = 'other'` and notes is empty
    - Show approval-pending confirmation screen for threshold-exceeding adjustments
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 16.4 Write property test for adjustment reason code completeness (Property 9)
    - **Property 9: Adjustment Reason Code and Snapshot Completeness**
    - Generate arbitrary (reason_code, delta, before_quantity) tuples; assert resulting movement has non-null reason_code, before_quantity, after_quantity, and `after_quantity = before_quantity + delta`
    - **Validates: Requirements 5.1, 5.3, 5.4**

  - [ ]* 16.5 Write property test for approval threshold enforcement (Property 10)
    - **Property 10: Approval Threshold Enforcement**
    - Generate arbitrary (delta, threshold) where `ABS(delta) > threshold`; simulate staff submission; assert no movement row created and balance unchanged until owner approves
    - **Validates: Requirements 5.5, 5.6, 5.7**

- [x] 17. Implement cycle count and full audit workflow 🟢
  - [x] 17.1 Create count session Edge Functions
    - `supabase/functions/start-count-session/index.ts`: creates `stock_count_sessions` row; snapshots `inventory_balances` into `stock_count_lines.snapshot_quantity` for all in-scope SKUs
    - `supabase/functions/submit-count-line/index.ts`: accepts `{ session_id, sku_id, counted_quantity, idempotency_key }`; computes variance; creates `count_correction` movement if variance ≠ 0; updates `stock_count_lines`
    - `supabase/functions/complete-count-session/index.ts`: computes session summary (total SKUs, variance units, variance value); updates session status to `completed`
    - `supabase/functions/cancel-count-session/index.ts`: rolls back all submitted count_correction movements for the session via offsetting adjustments; warns user before cancel
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.6, 6.7_

  - [x] 17.2 Build count session mobile UI
    - `src/app/(app)/count/index.tsx`: choose count type (cycle/full); show in-progress session if one exists
    - `src/app/(app)/count/[sessionId].tsx`: scan SKU barcode → show name only (no system balance shown until submitted per req 6.3); quantity input; submit per line
    - Show variance and confirmation dialog after each submission; show session summary on completion
    - Offline: queue `submit-count-line` calls in MMKV; process on reconnect
    - _Requirements: 6.2, 6.3, 6.4, 6.8, 6.9_

  - [ ]* 17.3 Write property test for count session variance correctness (Property 11)
    - **Property 11: Count Session Variance Correctness**
    - Generate arbitrary (snapshot_quantity, counted_quantity) pairs; assert `variance = counted - snapshot`; if variance ≠ 0, assert exactly one count_correction movement with `quantity_delta = variance`; assert updated balance equals `counted_quantity`
    - **Validates: Requirements 6.4, 6.5**


---

### Phase 7: Purchase Orders (CRUD, Status Machine)

- [x] 18. Implement purchase order data layer and state machine 🟢
  - [x] 18.1 Create PO CRUD Edge Functions and hooks
    - `supabase/functions/create-po/index.ts`: validates role (`owner` or `purchasing`); creates PO in `draft` with lines
    - `supabase/functions/update-po/index.ts`: validates PO is in `draft`; allows editing lines
    - `supabase/functions/submit-po/index.ts`: transitions `draft → submitted`; records `submitted_at` and `submitted_by`; locks PO
    - `supabase/functions/cancel-po/index.ts`: transitions `draft/submitted → cancelled`
    - `src/hooks/usePurchaseOrders.ts`: `usePurchaseOrders()`, `usePurchaseOrder(poId)`, and mutation hooks
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 18.2 Build PO list and detail screens
    - `src/app/(app)/orders/index.tsx`: list POs with status filter; badge counts by status
    - `src/app/(app)/orders/[poId].tsx`: PO header (supplier, dates, status); line items with ordered/received qty; action buttons (submit, cancel, edit)
    - Show MOQ warning when user manually enters quantity below `supplier.minimum_order_qty`
    - Supabase Storage attachment upload for receipt documents
    - _Requirements: 8.2, 8.3, 8.4, 8.7_

  - [ ]* 18.3 Write property test for PO state machine validity (Property 14)
    - **Property 14: PO State Machine Validity**
    - Generate arbitrary (current_status, target_status) pairs; assert only valid transitions are accepted; assert invalid transitions return an error without modifying the PO
    - **Validates: Requirements 8.1**

  - [ ]* 18.4 Write RLS validation test for purchase_orders
    - Business A user cannot SELECT or INSERT POs where `business_id = Business B`
    - `staff` role user receives RLS rejection when attempting to INSERT into `purchase_orders`
    - _Requirements: 9.2, 9.4_


---

### Phase 8: Square Integration

- [x] 19. Implement Square webhook ingestion Edge Function 🟢
  - [x] 19.1 Create `square-webhook` Edge Function skeleton with HMAC verification
    - `supabase/functions/square-webhook/index.ts`
    - Verify `x-square-hmacsha256-signature` header against webhook signature key from Supabase env secret
    - Return 401 on invalid signature; return 200 immediately if `square_event_id` already exists (idempotent ACK, status=duplicate)
    - INSERT `square_sync_events` row with `status = 'pending'`
    - _Requirements: 3.1, 3.2, 3.6, 3.10_

  - [x] 19.2 Implement event handlers: sale and refund/void
    - `payment.completed` / `order.fulfilled`: extract line items; look up SKU by Square catalog item ID; INSERT `sale` movement (negative delta) per SKU
    - `refund.created` / `payment.refunded`: INSERT `return` movement (positive delta) referencing original sale via `reference_id`
    - `order.cancelled` / `payment.voided`: INSERT offsetting movement to reverse any prior sale decrements
    - Unmatched SKU: UPDATE `square_sync_events` status to `unmatched`; INSERT `square_unmatched` alert
    - _Requirements: 3.1, 3.3, 3.4, 3.5_

  - [x] 19.3 Implement retry logic and dead-letter handling
    - On transient error: increment `retry_count`; exponential backoff schedule (immediate, +30s, +2min); after 3 failures set `status = 'failed'`
    - Create `supabase/functions/square-webhook-retry/index.ts`: scheduled every 5 min; queries `square_sync_events` with `status = 'pending'` and `retry_count > 0`; re-dispatches to event handler
    - _Requirements: 3.7_

  - [ ]* 19.4 Write property test for Square webhook idempotency (Property 4)
    - **Property 4: Square Webhook Idempotency**
    - Generate arbitrary webhook payloads with a fixed `square_event_id`; simulate processing the same payload N times; assert movement row count equals count from first processing only; assert subsequent records have `status = 'duplicate'`
    - **Validates: Requirements 3.2**

  - [ ]* 19.5 Write property test for offsetting movements (Property 5)
    - **Property 5: Offsetting Movements for Refunds and Voids**
    - Generate arbitrary sale event then refund event for same SKU; assert net balance after both equals balance before either; assert `quantity_delta` of refund movement exactly offsets sale movement
    - **Validates: Requirements 3.4, 3.5**

  - [ ]* 19.6 Write property test for webhook retry bound (Property 6)
    - **Property 6: Square Webhook Retry Bound**
    - Simulate a webhook that always fails; assert `retry_count` never exceeds 3 and status becomes `'failed'` after exactly 4 total attempts
    - **Validates: Requirements 3.7**

- [x] 20. Implement Square reconciliation and catalog sync 🟢
  - [x] 20.1 Create `square-reconcile` Edge Function (scheduled)
    - `supabase/functions/square-reconcile/index.ts`: runs every 60 min
    - Check last successful `square_sync_events` timestamp; if > 60 min ago, query Square Orders API for orders since last sync
    - Compare against existing `square_sync_events` records; synthesize and process any missing `payment.completed` events
    - _Requirements: 3.9_

  - [x] 20.2 Create `square-catalog-sync` Edge Function
    - `supabase/functions/square-catalog-sync/index.ts`: maps Square catalog items to `products` and `product_barcodes`
    - Store `square_catalog_item_id` in `products` (add column in migration if not already present); map item variations to `product_variants`
    - Populate `product_barcodes` from Square item UPC/barcode data
    - _Requirements: 3.1 (SKU matching), Phase 2 requirement note in Req 3_

  - [x] 20.3 Build admin Square sync events view
    - `src/app/(app)/admin/square-events.tsx`: table of `square_sync_events` filtered by `status IN ('failed', 'unmatched')` (Owner only)
    - Show: event type, event ID, error message, retry count, created_at
    - Action buttons: "Retry" (re-queues for processing), "Mark Resolved" (sets status to a resolved terminal state)
    - _Requirements: 3.8_

  - [ ]* 20.4 Write Square sandbox integration test
    - Configure local env with Square sandbox credentials
    - POST a mock `payment.completed` payload with valid HMAC signature to `square-webhook` function
    - Assert: `square_sync_events` row created with `status = 'success'`; `inventory_movements` row created with correct negative delta; `inventory_balances` decremented
    - POST same payload again; assert `status = 'duplicate'` and no additional movement row
    - _Requirements: 3.1, 3.2, 3.6_


---

### Phase 9: Low-Stock Alerts and Realtime

- [x] 21. Implement alert trigger and Realtime subscription 🟢
  - [x] 21.1 Extend `update_inventory_balance` trigger to evaluate alert conditions
    - After balance update: if `new_balance.quantity <= product.reorder_point`, check for existing active `low_stock` alert; if none, INSERT `alerts` row
    - If `new_balance.quantity <= 0`, INSERT `stockout` alert (in addition to low_stock)
    - If new balance > reorder_point AND an active `low_stock` alert exists: UPDATE alert status to `resolved`, set `resolved_at`
    - Add SQL migration for alert trigger logic (idempotent, part of `_03_inventory_ledger.sql` or a new patch migration)
    - _Requirements: 4.1, 4.2, 4.5, 4.7, 4.8_

  - [x] 21.2 Create Supabase Realtime alert subscription hook
    - `src/hooks/useAlerts.ts`: subscribe to `postgres_changes` on `alerts` table filtered by `business_id`
    - On INSERT of new alert: update in-app notification badge; show toast/banner
    - Alert must appear in-app within 5 seconds of movement causing balance change
    - TanStack Query invalidation on alert INSERT to refresh dashboard KPIs
    - _Requirements: 4.3_

  - [x] 21.3 Build alerts feed and acknowledgement UI
    - In-app notification feed component (rendered in `(app)/_layout.tsx`)
    - Alert list: type badge, SKU name, current balance, created_at, status
    - Acknowledge action: PATCH alert to `status = 'acknowledged'`; records user_id and timestamp
    - _Requirements: 4.6_

  - [ ]* 21.4 Write property test for alert creation at threshold (Property 7)
    - **Property 7: Alert Creation at Reorder Threshold**
    - Generate arbitrary (balance, reorder_point) pairs where balance ≤ reorder_point; assert exactly one active `low_stock` alert; no duplicate active alerts for same SKU-location; if balance ≤ 0, assert one active `stockout` alert also exists
    - **Validates: Requirements 4.1, 4.2, 4.5**

  - [ ]* 21.5 Write property test for alert auto-resolution on restock (Property 8)
    - **Property 8: Alert Auto-Resolution on Restock**
    - Given an active `low_stock` alert; simulate receive movement that raises balance above reorder_point; assert alert transitions to `resolved`; assert alert record still exists (not deleted)
    - **Validates: Requirements 4.7, 4.8**

- [x] 22. Architect push notification infrastructure (Phase 2, schema only in MVP) 🔵
  - [x] 22.1 Add push token table and notification preference schema
    - Create `supabase/migrations/<timestamp>_10_push_tokens.sql`: `user_push_tokens(user_id, token, platform, created_at)`
    - Add `notification_preferences` column (JSONB) to `user_profiles`: stores per-channel opt-in flags
    - `expo-notifications` dependency installed; `registerForPushNotificationsAsync()` helper written but not called (guarded by feature flag `PUSH_NOTIFICATIONS_ENABLED = false`)
    - _Requirements: 4.9_


---

### Phase 10: Dashboard and Reports

- [x] 23. Implement dashboard KPI data layer 🟢
  - [x] 23.1 Create Postgres views / functions for dashboard KPIs
    - Create `dashboard_kpis(business_id, location_id)` Postgres function returning: total_units_on_hand, total_inventory_value, low_stock_count, stockout_count, stockout_risk_count, sell_through_rate_30d, shrink_rate_30d, gross_sales_30d
    - Sell-through rate: units sold in 30d / (units sold + current balance)
    - Shrink/adjustment rate: ABS(SUM(delta)) for theft/spoilage/damage in 30d / received_30d
    - Stockout risk: count of SKUs where `projected_balance_at_arrival <= reorder_point`
    - Add migration for the function
    - _Requirements: 10.1, 10.7_

  - [x] 23.2 Build dashboard screen
    - `src/app/(app)/dashboard/index.tsx`: 8 KPI cards in 2×4 grid using NativeWind
    - Each card is tappable; navigates to corresponding report view
    - Initial render within 2 seconds on 4G (TanStack Query with stale-while-revalidate; show skeleton loaders)
    - _Requirements: 10.1, 10.2, 15.1_

- [x] 24. Implement report views 🟢
  - [x] 24.1 Build stock on hand and inventory valuation reports
    - `src/app/(app)/reports/index.tsx`: report type selector
    - Stock On Hand: paginated list with balance, cost_price, total value per SKU; filterable by category/supplier/SKU
    - Inventory Valuation: weighted average cost breakdown; total value footer
    - _Requirements: 10.3, 10.5, 10.7_

  - [x] 24.2 Build low-stock, sales velocity, and dead stock reports
    - Low-Stock & Stockout Risk: list SKUs at/below reorder_point; show days until projected stockout
    - Forecasted Reorder Risk: `projected_balance_at_arrival` per SKU based on 30d velocity × lead time
    - Sales Velocity by SKU: units/day for last 7, 30, 90 days
    - Dead Stock / Slow Movers: SKUs with zero sale movements in last 60 days and balance > 0
    - _Requirements: 10.3, 10.8_

  - [x] 24.3 Build shrinkage, PO history, and movement ledger reports
    - Shrinkage & Adjustment Log: movements of type `adjustment` filterable by reason_code, user, date range, SKU
    - PO History: list all POs with status, supplier, total cost; tap to view detail
    - Inventory Movement History: raw ledger view filterable by movement_type, date range, SKU
    - All report queries must return within 3 seconds for up to 10,000 ledger entries
    - _Requirements: 10.3, 10.4, 10.5_

  - [x] 24.4 Implement CSV export
    - Each report view has an "Export CSV" button (Owner and Accountant only)
    - Serialize current filtered result set to CSV; write to device via `expo-file-system`; share sheet via `expo-sharing`
    - _Requirements: 10.6_

  - [ ]* 24.5 Write RLS validation test for reports (inventory_movements SELECT)
    - Business B user attempting to query inventory_movements with Business A's `business_id` returns 0 rows
    - `staff` role user attempting to query reports returns 0 rows (RLS blocks SELECT per role policy)
    - _Requirements: 9.2, 9.4_


---

### Phase 11: AI Recommendation Engine

- [x] 25. Implement `ai-recommendations` Edge Function 🟢
  - [x] 25.1 Build reorder recommendation heuristic
    - `supabase/functions/ai-recommendations/index.ts`
    - Query `inventory_balances`, `products`, `inventory_movements` (30d velocity), `purchase_orders` (open PO qty)
    - Per SKU: compute `projected_balance_at_arrival`; if ≤ `reorder_point`, compute `suggested_qty` (capped at MOQ, rounded to case pack)
    - Generate `rationale_text` from template referencing velocity, balance, lead_time, open_po_qty, reorder_point
    - INSERT `recommendations` (type=reorder) and draft `purchase_orders` (source=ai_suggested) with `purchase_order_lines.rationale_text`
    - Suppress recommendations for SKUs rejected with `not_needed` or `already_ordered` in last 7 days
    - _Requirements: 11.1, 11.2, 11.4, 11.6, 8.5, 8.6_

  - [x] 25.2 Build dead stock, count priority, and anomaly detection
    - Dead stock: flag SKUs with zero sales in last 60 days AND balance > 0
    - Count priority: if `shrinkage_30d / received_30d > 0.10`, flag for count
    - Anomaly (Z-score): compute 90d daily velocity distribution; flag SKUs where 7d average deviates > 3 std devs
    - Each algorithm inserts to `recommendations` with correct type and `confidence_level = 'heuristic'`
    - Schedule function hourly via Supabase cron
    - _Requirements: 11.7, 11.8, 11.9_

  - [ ]* 25.3 Write property test for reorder quantity calculation (Property 16)
    - **Property 16: Reorder Quantity Calculation Correctness**
    - Generate arbitrary inputs (balance, reorder_point, safety_stock, lead_time_days, velocity, open_po_qty, MOQ); assert `suggested_qty >= MOQ`, `suggested_qty >= 0`, and projected balance at arrival > `reorder_point + safety_stock`
    - **Validates: Requirements 11.6**

  - [ ]* 25.4 Write property test for dead stock detection (Property 17)
    - **Property 17: Dead Stock Detection Completeness**
    - Given a SKU with last sale > 60 days ago and balance > 0; run heuristic; assert at least one non-expired `dead_stock` recommendation exists
    - **Validates: Requirements 11.7**

  - [ ]* 25.5 Write property test for Z-score anomaly detection (Property 18)
    - **Property 18: Anomaly Detection Z-Score Property**
    - Generate 90d daily velocity series with known mean/stddev; inject a 7d window where average > mean + 3×stddev; assert `anomaly` recommendation created
    - **Validates: Requirements 11.8**

- [x] 26. Build recommendations feed mobile UI 🟢
  - [x] 26.1 Build recommendations list and detail screens
    - `src/app/(app)/recommendations/index.tsx`: pending recommendations feed grouped by type; badge in dashboard
    - Each card shows: type, SKU name, rationale_text, confidence_level label, suggested_quantity
    - Display `heuristic` / `forecast` badge prominently; never label as "AI prediction"
    - Dashboard and recommendations feed update via Realtime on new recommendation INSERT
    - Auto-expire `pending` recommendations older than 30 days (handled server-side by scheduled function)
    - _Requirements: 11.3, 11.10, 11.11_

  - [x] 26.2 Implement recommendation accept/reject workflow
    - Accept: UPDATE recommendation `status = accepted`; INSERT `recommendation_feedback` (action=accepted); trigger draft PO creation (if type=reorder, reuse existing draft PO from Phase 7 creation logic)
    - Reject: show reason code picker (`already_ordered`, `not_needed`, `wrong_quantity`, `other`); INSERT `recommendation_feedback` (action=rejected); UPDATE status=rejected
    - _Requirements: 11.4, 11.5, 8.8, 8.9_

  - [ ]* 26.3 Write property test for AI-suggested PO rationale completeness (Property 15)
    - **Property 15: AI-Suggested PO Rationale Completeness**
    - For every PO created with `source = 'ai_suggested'`, assert every PO line has non-empty `rationale_text` referencing balance, velocity, lead_time, and suggested_qty
    - **Validates: Requirements 8.5, 8.6**


---

### Phase 12: Offline Queue and Sync

- [x] 27. Implement offline queue core infrastructure 🟢
  - [x] 27.1 Implement MMKV-backed offline queue store
    - `src/lib/offlineQueue.ts`: serialize/deserialize `OfflineAction` to MMKV using a namespaced key
    - `src/stores/offlineQueueStore.ts` (Zustand): `enqueue(action)`, `dequeue()`, `getAll()`, `remove(id)`, `updateStatus(id, status)`
    - Each action has client-generated UUID idempotency key: `${deviceId}:${actionType}:${timestamp}:${randomUUID()}`
    - _Requirements: 13.2, 13.7_

  - [x] 27.2 Implement sync-on-reconnect logic
    - `src/stores/syncStore.ts` (Zustand): `processPendingActions()` — iterates MMKV queue in FIFO order; POSTs each to corresponding Edge Function with idempotency key
    - NetInfo listener in `src/app/(app)/_layout.tsx`: on `isConnected = true` → show sync banner → call `processPendingActions()`
    - On success: remove from queue, refresh TanStack Query caches
    - On conflict (409): flag action with `status = 'failed'`; show specific error message to user; allow retry or discard
    - On server error: increment `retryCount`; keep in queue
    - _Requirements: 13.4, 13.5, 13.6_

  - [x] 27.3 Wire offline queue to receive, adjustment, and count workflows
    - In `src/app/(app)/receive/[poId].tsx`: call `offlineQueueStore.enqueue()` when network unavailable; show "Pending sync" badge
    - In `src/app/(app)/inventory/[skuId].tsx` (adjustment): same offline enqueue pattern
    - In `src/app/(app)/count/[sessionId].tsx`: enqueue count-line submissions when offline
    - Product catalog: show stale balance with "balance as of [time]" when offline
    - _Requirements: 13.1, 13.2, 13.3, 13.6_

  - [ ]* 27.4 Write property test for offline queue idempotency (Property 20)
    - **Property 20: Offline Queue Idempotency**
    - Generate an action with a fixed idempotency key; simulate processing it N times via the Edge Function; assert `offline_queue_log` has one `processed` record; assert no additional `inventory_movements` rows created on subsequent submissions
    - **Validates: Requirements 13.7**


---

### Phase 13: Testing, RLS Validation, Monitoring, and Admin Tools

- [x] 28. Complete property-based test suite 🟢
  - [x] 28.1 Write remaining property tests not yet covered in earlier phases
    - **Property 19: Tenant Isolation via RLS** — generate JWTs for Business A and B; assert no cross-tenant row leakage for every business-data table; **Validates: Requirements 12.3, 9.4**
    - Integrate all property tests into Jest CI run; tag each with `// Feature: ai-inventory-manager, Property N:`
    - Set `numRuns: 100` for all `fc.assert` calls; add seed logging for CI reproduction
    - _Requirements: Design Testing Strategy_

  - [ ]* 28.2 Write RLS validation test suite for all critical tables
    - For each of: `inventory_movements`, `inventory_balances`, `purchase_orders`, `products`, `alerts`, `recommendations`, `square_sync_events`
    - Test: Business B user returns 0 rows for Business A data
    - Test: role without write permission receives RLS rejection on INSERT/UPDATE
    - Run against local Supabase stack (`supabase start`)
    - _Requirements: 9.4, 12.3, 14.2_

- [x] 29. Implement audit logging and health-check endpoint 🟢
  - [x] 29.1 Create audit log infrastructure
    - Add `audit_log` table migration: `(log_id, business_id, user_id, event_type, table_name, record_id, details JSONB, created_at)`
    - Log: all auth events (sign-in, sign-out, invite, remove), all permission-denied events, all inventory-affecting operations (via Edge Function middleware)
    - Use `useErrorHandler` hook on client to route 403 errors to audit log via Edge Function call
    - _Requirements: 15.4_

  - [x] 29.2 Implement ledger consistency health-check endpoint
    - `supabase/functions/health-check/index.ts` (requires `owner` JWT): queries every `(sku_id, location_id)` pair; compares `inventory_balances.quantity` to `get_inventory_balance(sku_id, location_id)` output; returns list of any inconsistencies
    - Wire to a "Run Consistency Check" button in Owner settings screen
    - _Requirements: 15.3_

- [x] 30. Final integration and end-to-end testing pass 🟢
  - [ ]* 30.1 Write integration tests for trigger behavior
    - Test `update_inventory_balance` fires on movement INSERT and balance is correct
    - Test `low_stock` alert created when balance falls to reorder_point
    - Test `prevent_movement_mutation` trigger blocks UPDATE and DELETE
    - _Requirements: 1.3, 1.5, 4.1_

  - [ ]* 30.2 Write integration tests for Edge Function behavior
    - Square webhook: POST mock payload → assert movement, sync_event, balance all correct
    - Receive-stock with idempotency: POST twice with same key → assert single movement row
    - Adjust-stock approval threshold: POST staff adjustment above threshold → assert pending_approval, no movement
    - _Requirements: 2.3, 3.2, 5.5_

- [x] 31. Checkpoint — all tests passing 🟢
  - Run full Jest suite (unit + property tests): `npm test -- --runInBand`
  - Run RLS validation tests against local Supabase
  - Run `supabase db push` migration against local stack with zero errors
  - Ask the user if questions arise.


---

### Phase 14: Demo Data, Staging, and Pre-Launch

- [x] 32. Configure staging environment and CI/CD pipeline 🟢
  - [x] 32.1 Set up staging Supabase project
    - Create dedicated Supabase project for staging; configure Square sandbox credentials in Supabase Vault
    - Apply all migrations via `supabase db push --project-ref <staging-ref>` in CI
    - Document environment variable matrix (local / staging / production) in `README.md`
    - _Requirements: Design Deployment Environments_

  - [x] 32.2 Complete GitHub Actions CI/CD pipeline
    - Add `deploy-staging.yml` workflow: trigger on push to `main` → run tests → `supabase db push` → deploy Edge Functions via `supabase functions deploy`
    - Add `deploy-production.yml` workflow: trigger on tagged release → same steps against production project
    - Add step to run RLS validation test suite in CI against local Supabase Docker container
    - _Requirements: Design Deployment Environments_

- [x] 33. Load demo data and validate staging environment 🟢
  - [x] 33.1 Apply seed data to staging
    - Run `supabase db reset --project-ref <staging-ref>` then `psql ... < supabase/seed.sql` in CI staging deploy step
    - Verify: 20+ products, 2 suppliers, 30 days of movements, correct balances, 1 submitted PO, active low-stock alerts
    - _Requirements: 14.5_

  - [ ]* 33.2 Run Square sandbox end-to-end validation
    - Use Square sandbox dashboard to simulate a completed payment with line items mapped to seeded SKUs
    - Verify webhook received → processed → movement created → balance decremented → alert state correct
    - Simulate a refund; verify return movement created and balance restored
    - _Requirements: 3.1, 3.4, 3.9_

  - [ ]* 33.3 Validate push notification schema is inert in MVP
    - Assert `PUSH_NOTIFICATIONS_ENABLED` flag is `false`; assert no push tokens are registered in staging
    - Assert `user_push_tokens` table exists and has correct schema (Phase 2 readiness check)
    - _Requirements: 4.9_


---

## Notes

- Tasks marked with `*` are optional and will not be auto-executed. They cover tests and validation steps that are strongly recommended but can be deferred for a faster MVP build.
- Every inventory mutation (receive, sale, adjustment, count_correction, return, transfer) goes through `inventory_movements`. Direct balance updates are prohibited by both a Postgres trigger and RLS.
- All Square API calls are server-side only (Edge Functions). The mobile client never receives or stores Square credentials.
- The `business_id` column on every table is the tenant boundary enforced by RLS. The MVP supports one store; adding a second requires only a new `locations` row and no schema migration.
- AI recommendations are heuristics-only in MVP (reorder projection, dead stock, Z-score anomaly, shrinkage count priority). No external ML service is called.
- The offline queue uses `react-native-mmkv` for synchronous local persistence. All queued actions carry a client-generated UUID idempotency key. The server deduplicates against `offline_queue_log`.
- Push notification infrastructure (schema + `expo-notifications` dependency) is architected in MVP (Task 22.1) but gated behind `PUSH_NOTIFICATIONS_ENABLED = false`. No tokens are registered and no notifications are delivered in MVP.
- Property tests use `fast-check` with `numRuns: 100`. Each test is tagged with `// Feature: ai-inventory-manager, Property N:` for traceability back to the design document.
- Migrations are Supabase CLI versioned files in `supabase/migrations/`, named with timestamp prefix. Each migration is designed to be idempotent.


## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["0.1", "1.1"]
    },
    {
      "id": 1,
      "tasks": ["0.2", "0.3", "0.4", "1.2"]
    },
    {
      "id": 2,
      "tasks": ["2.1", "3.1", "4.1", "5.1", "6.1"]
    },
    {
      "id": 3,
      "tasks": ["2.2", "3.2", "4.2", "4.3", "5.2", "6.2", "7.1"]
    },
    {
      "id": 4,
      "tasks": ["4.4", "4.5", "7.2", "8.1"]
    },
    {
      "id": 5,
      "tasks": ["8.2", "10.1", "12.1"]
    },
    {
      "id": 6,
      "tasks": ["8.3", "8.4", "10.2", "10.3", "12.2", "12.3", "12.4"]
    },
    {
      "id": 7,
      "tasks": ["9.1", "9.2", "11.1", "11.2", "11.3", "11.4", "14.1", "16.1", "17.1", "18.1"]
    },
    {
      "id": 8,
      "tasks": ["14.2", "15.1", "15.3", "16.2", "16.3", "16.4", "16.5", "17.2", "17.3", "18.2", "18.3", "18.4"]
    },
    {
      "id": 9,
      "tasks": ["15.2", "19.1", "21.1"]
    },
    {
      "id": 10,
      "tasks": ["19.2", "19.3", "19.4", "19.5", "19.6", "21.2", "21.3", "21.4", "21.5", "22.1"]
    },
    {
      "id": 11,
      "tasks": ["20.1", "20.2", "20.3", "23.1", "25.1", "27.1"]
    },
    {
      "id": 12,
      "tasks": ["20.4", "23.2", "24.1", "25.2", "27.2", "27.3"]
    },
    {
      "id": 13,
      "tasks": ["24.2", "24.3", "24.4", "24.5", "25.3", "25.4", "25.5", "26.1", "27.4"]
    },
    {
      "id": 14,
      "tasks": ["26.2", "26.3", "28.1", "29.1", "29.2"]
    },
    {
      "id": 15,
      "tasks": ["28.2", "30.1", "30.2"]
    },
    {
      "id": 16,
      "tasks": ["32.1"]
    },
    {
      "id": 17,
      "tasks": ["32.2", "33.1"]
    },
    {
      "id": 18,
      "tasks": ["33.2", "33.3"]
    }
  ]
}
```
