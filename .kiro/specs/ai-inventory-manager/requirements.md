# Requirements Document

## Introduction

The AI Inventory Manager is a mobile-first inventory and purchasing application designed for micro retail businesses such as convenience stores. The system acts as an intelligent inventory assistant, helping owners and staff track stock in real time, reduce stockouts, simplify receiving and audits, integrate with POS systems (initially Square), and recommend purchase orders and inventory actions using historical sales data and trend analysis.

The MVP targets a single-store deployment with an architecture designed for multi-location expansion. The primary interface is a mobile phone running a React Native (Expo) application backed by Supabase (Postgres, Auth, Storage, Realtime, Edge Functions).

---

## Open Product Decisions

The following product decisions were identified and resolved for MVP scope. They are documented here for stakeholder alignment.

| Decision | MVP Resolution |
|---|---|
| Single-store vs multi-location | MVP supports a single store per business. Schema is multi-tenant and location-aware to enable multi-location in a future phase. |
| Manual sales entry | Manual sales entry is allowed as a fallback when POS integration is unavailable or for cash/offline sales not captured by POS. Manual entries are logged with a `source: manual` flag. |
| Inventory reservations | Not in MVP. Reserved stock is a Phase 2 feature. |
| Offline scope | Offline-aware UX is required for receiving, counting, and adjustments. Actions are queued locally and synced when connectivity is restored. Conflict resolution: last-write-wins for counts; ledger append for movements. |
| Notification channels | In-app alerts only for MVP. Push notification infrastructure (Expo Notifications) is architected but not activated. |
| Return and refund handling | Returns from Square decrement the POS-sourced outbound movement and create a positive inbound movement. Manual returns follow the adjustment workflow with reason `return`. |
| Permission granularity | Four roles: Owner, Staff, Purchasing, Accountant. See Requirement 9 for role matrix. |
| Supplier catalog depth | MVP supports supplier name, contact, lead time, and minimum order quantity. Full supplier catalog/EDI is Phase 2. |
| Accounting / ERP export | Not in MVP. CSV export of reports is sufficient. Phase 2 may include QuickBooks or Xero integration. |
| Dashboard — mobile-only or web admin | Mobile-only for MVP. Web admin console is a Phase 2 consideration. |

---

## Assumptions

- A barcode scanner SDK compatible with Expo is available (e.g., `expo-barcode-scanner` or `expo-camera`).
- Square webhooks are delivered to a publicly accessible Supabase Edge Function URL.
- All inventory quantity mutations flow through the inventory movement ledger; direct balance updates are prohibited.
- A single business entity owns one store in MVP; the `business_id` / `location_id` schema supports expansion.
- AI/ML recommendations in MVP are heuristics and statistical forecasting; no external ML model service is required at launch.
- The app will be distributed via Expo Go or a standalone build; App Store / Play Store submission is out of scope for MVP.

---

## Glossary

- **App**: The AI Inventory Manager React Native / Expo mobile application.
- **System**: The complete platform including the App, Supabase backend, and Edge Functions.
- **Business**: A single retail business entity (tenant) that owns one or more Stores.
- **Store** / **Location**: A physical retail location belonging to a Business.
- **Owner**: A user with full administrative privileges over a Business.
- **Staff**: A store employee with limited operational permissions (scan, adjust, receive, count).
- **Purchasing_User**: A user responsible for creating and managing purchase orders.
- **Accountant**: A read-only reporting user.
- **SKU**: Stock Keeping Unit — a unique product identifier internal to the Business.
- **Barcode**: A machine-readable code (UPC, EAN, QR, etc.) printed on a product and used to look up its SKU.
- **Product**: A product record linked to one or more Barcodes and one or more SKUs.
- **Variant**: A size, pack, or unit-of-measure variation of a Product (e.g., single can vs. 6-pack).
- **Inventory_Balance**: The current on-hand quantity for a SKU at a Location, derived from the Ledger.
- **Ledger**: The append-only inventory movement ledger that is the single source of truth for all stock quantity changes.
- **Movement**: A single Ledger entry recording a quantity change for a SKU at a Location (positive = inbound, negative = outbound).
- **Purchase_Order** / **PO**: A formal or informal order placed with a Supplier to replenish stock.
- **PO_Line**: A single product-quantity line item within a Purchase_Order.
- **Supplier**: A vendor from whom the Business purchases products.
- **Reorder_Point**: The on-hand quantity at which a reorder alert is triggered for a SKU.
- **Safety_Stock**: Buffer stock held above the Reorder_Point to cover demand variability or lead time delays.
- **Lead_Time**: The number of days between placing a PO and receiving goods from a Supplier.
- **Stockout**: A condition where the Inventory_Balance for a SKU reaches zero.
- **Shrinkage**: Unexplained inventory loss captured via the adjustment reason codes `theft`, `spoilage`, or `damage`.
- **Cycle_Count**: A partial stocktake covering a subset of SKUs on a rotating schedule.
- **Full_Audit**: A complete physical stocktake covering all SKUs at a Location.
- **Square**: The POS system integrated with the System for sales and catalog sync.
- **Webhook**: An HTTP callback sent by Square to a System Edge Function when a Square event occurs.
- **Idempotency_Key**: A unique token used to ensure that retried operations are not applied more than once.
- **AI_Assistant**: The heuristics and forecasting engine within the System that generates inventory recommendations.
- **Recommendation**: An AI_Assistant-generated suggestion (reorder, count, investigate) with a plain-language rationale.
- **Alert**: A system-generated notification triggered by a rule (e.g., stock below Reorder_Point).
- **RLS**: Row Level Security — Supabase Postgres feature used to enforce tenant and role isolation at the database level.
- **Edge_Function**: A Supabase server-side function used for integrations, webhooks, and privileged operations.
- **Offline_Queue**: A local store of pending actions accumulated while the device has no connectivity.

---

## Requirements

### Requirement 1: Inventory Movement Ledger (Core Invariant)

**User Story:** As an Owner, I want every stock quantity change to be recorded in an immutable ledger, so that I can always trace the full history of any inventory movement and trust the accuracy of on-hand balances.

#### Acceptance Criteria

1. THE System SHALL maintain an append-only Ledger where each Movement record contains: `movement_id`, `business_id`, `location_id`, `sku_id`, `quantity_delta` (positive or negative), `movement_type` (receive, sale, return, adjustment, count_correction, transfer), `source` (pos_square, manual, system), `reference_id`, `user_id`, `notes`, and `created_at`.
2. THE System SHALL derive all Inventory_Balance values by aggregating quantity_delta values in the Ledger; THE System SHALL NOT store a mutable balance field that can be updated independently of a Ledger entry.
3. WHEN a Movement is written to the Ledger, THE System SHALL update the materialized Inventory_Balance for the affected SKU and Location within the same database transaction.
4. IF a Ledger write fails, THEN THE System SHALL roll back the corresponding Inventory_Balance update and return an error to the caller.
5. THE System SHALL enforce that no Movement record is deleted or updated after creation; correction of erroneous movements SHALL be performed by creating an offsetting Movement with type `adjustment` and reason `counting_correction`.
6. THE System SHALL record the `user_id` of the authenticated user or the `edge_function_id` of the service process on every Movement entry.
7. FOR ALL SKUs at a Location, the sum of all Ledger quantity_delta values for that SKU SHALL equal the current materialized Inventory_Balance for that SKU at that Location (ledger-balance consistency invariant).

---

### Requirement 2: Stock Receiving

**User Story:** As a Staff or Purchasing_User, I want to receive goods against a purchase order or as an ad hoc receipt, so that on-hand inventory is updated immediately and receiving records are preserved for audit.

#### Acceptance Criteria

1. WHEN a user initiates a receive stock workflow, THE App SHALL allow the user to select an open or partially-received Purchase_Order or choose ad hoc receiving without a PO.
2. WHEN a user scans or manually enters a Barcode during receiving, THE App SHALL resolve the Barcode to its linked SKU and Product and pre-populate the product name and expected quantity from the PO_Line if a PO is selected.
3. WHEN a user confirms a received quantity for a PO_Line, THE System SHALL create a Movement of type `receive` in the Ledger with quantity_delta equal to the received quantity and update the PO_Line received quantity.
4. THE System SHALL capture the following fields on each receive transaction: received_quantity, damaged_quantity, unit_cost, supplier_id, receive_date, receiving_user_id, and po_id (nullable for ad hoc).
5. WHEN damaged_quantity is greater than zero, THE System SHALL create a separate Movement of type `adjustment` with reason `damage` for the damaged quantity so that damaged goods are not added to available Inventory_Balance.
6. WHEN a received quantity is less than the ordered quantity on a PO_Line, THE System SHALL mark the PO_Line status as `partially_received` and keep the PO status as `partially_received`.
7. WHEN all PO_Lines for a Purchase_Order have reached received_quantity >= ordered_quantity, THE System SHALL automatically set the PO status to `received`.
8. WHEN the App has no network connectivity during a receive workflow, THE App SHALL queue the receive action in the Offline_Queue and display a clear indicator that the action is pending sync.
9. WHEN the App regains network connectivity, THE System SHALL process all queued receive actions from the Offline_Queue in chronological order and notify the user of sync completion or any failures.
10. IF a queued receive action references a PO_Line that has been modified by another user during offline period, THEN THE System SHALL flag the conflict for manual review rather than silently overwriting the server state.

#### Phase 2 Enhancements
- Support multi-location transfers treated as a receive at the destination and a movement-out at the source.
- Support EDI-based advance shipping notices (ASN) to pre-populate receiving workflows.

---

### Requirement 3: POS Integration — Square Sales Sync

**User Story:** As an Owner, I want completed Square sales to automatically decrement inventory, so that on-hand balances stay accurate without manual entry after every transaction.

#### Acceptance Criteria

1. WHEN Square delivers a `payment.completed` or `order.fulfilled` webhook to the System Edge Function, THE Edge_Function SHALL extract all line items, match each item to its SKU by Square catalog item ID, and create a Movement of type `sale` with a negative quantity_delta for each SKU sold.
2. THE Edge_Function SHALL use an Idempotency_Key derived from the Square transaction ID to ensure that processing the same webhook event more than once does not create duplicate Movements.
3. WHEN a Square webhook cannot be matched to a known SKU, THE Edge_Function SHALL log the unmatched event with the Square item ID and alert the Owner for manual review rather than silently discarding the event.
4. WHEN Square delivers a `refund.created` or `payment.refunded` webhook, THE Edge_Function SHALL create a Movement of type `return` with a positive quantity_delta for each refunded SKU, referencing the original sale Movement via `reference_id`.
5. WHEN a Square transaction is voided or cancelled before fulfillment, THE Edge_Function SHALL create an offsetting Movement to reverse any previously applied inventory decrements.
6. THE System SHALL store each processed Square webhook event in a `square_sync_events` table with fields: `event_id`, `square_event_type`, `square_event_id`, `processed_at`, `status` (success, failed, unmatched, duplicate), and `error_message`.
7. WHEN a webhook processing attempt fails with a transient error, THE Edge_Function SHALL retry the event up to 3 times with exponential backoff before marking the event status as `failed` and queuing it for manual review.
8. THE System SHALL provide an admin view listing all `failed` and `unmatched` square_sync_events so the Owner can investigate and manually resolve discrepancies.
9. WHEN more than 60 minutes have elapsed since the last successful Square webhook and the Square API is reachable, THE System SHALL initiate a polling reconciliation call to the Square Orders API to identify any missed events.
10. THE Edge_Function SHALL never expose Square OAuth tokens or API credentials to the mobile client; all Square API calls SHALL be made server-side through Edge Functions.
11. WHERE a Business has not connected a Square account, THE System SHALL allow manual sales entry as a fallback; manual entries SHALL be recorded in the Ledger with `source: manual`.

#### Phase 2 Enhancements
- Support additional POS systems (Shopify, Clover, Lightspeed) via a modular integration adapter pattern.
- Real-time Square catalog sync to auto-create Product and Barcode records from Square items.

---

### Requirement 4: Low-Stock Alerts

**User Story:** As an Owner or Staff, I want to be notified when a product's stock falls below its reorder point, so that I can act before a stockout occurs.

#### Acceptance Criteria

1. WHEN a Movement causes the Inventory_Balance for a SKU to fall at or below the configured Reorder_Point for that SKU, THE System SHALL create an Alert of type `low_stock` for that SKU and Location.
2. THE System SHALL suppress duplicate low_stock Alerts: IF a low_stock Alert for the same SKU and Location is already in `active` status, THEN THE System SHALL NOT create a new Alert until the existing Alert has been resolved or acknowledged.
3. WHEN a low_stock Alert is created, THE App SHALL display the Alert in the in-app notification feed within 5 seconds for users who are actively using the App, using Supabase Realtime.
4. THE System SHALL allow the Owner or Purchasing_User to configure the following per SKU: `reorder_point`, `reorder_quantity`, `safety_stock`, `lead_time_days`, and `default_supplier_id`.
5. WHEN the Inventory_Balance for a SKU reaches zero, THE System SHALL create an Alert of type `stockout` in addition to any existing low_stock Alert.
6. THE System SHALL allow a user to acknowledge an Alert, which transitions the Alert status from `active` to `acknowledged` and records the acknowledging `user_id` and timestamp.
7. WHEN the Inventory_Balance for a SKU rises above its Reorder_Point following a receive Movement, THE System SHALL automatically resolve any active low_stock Alert for that SKU and Location.
8. THE System SHALL retain all Alerts including resolved ones for audit and reporting purposes; Alerts SHALL NOT be deleted.
9. WHERE push notification capability is enabled (Phase 2), THE System SHALL send a push notification via Expo Notifications when a stockout Alert is created; the push notification infrastructure SHALL be designed into the schema and Edge Function architecture in MVP even though delivery is inactive.

#### Phase 2 Enhancements
- SMS and email Alert channels via a configurable notification preference per user.
- Escalation rules: if an Alert is unacknowledged for more than N hours, escalate to Owner.

---

### Requirement 5: Stock Adjustments

**User Story:** As a Staff or Owner, I want to record manual stock adjustments with a required reason, so that inventory discrepancies are corrected and the cause is documented for audit purposes.

#### Acceptance Criteria

1. WHEN a user creates a stock adjustment, THE App SHALL require the user to select one of the following reason codes: `damage`, `spoilage`, `theft`, `counting_correction`, `supplier_shortage`, `internal_use`, `transfer_correction`, or `other`.
2. WHEN reason code `other` is selected, THE App SHALL require the user to enter a non-empty free-text note before the adjustment can be submitted.
3. WHEN a stock adjustment is submitted, THE System SHALL create a Movement of type `adjustment` in the Ledger with the selected reason code, the quantity_delta (positive or negative), the before-balance, the after-balance, the user_id, and the timestamp.
4. THE System SHALL record the `before_quantity` and `after_quantity` snapshots on each adjustment Movement so that the delta can be independently verified.
5. WHERE the Business has configured adjustment approval (Owner-configurable), THEN WHEN a Staff user submits an adjustment with an absolute quantity_delta greater than the configured approval threshold, THE System SHALL set the adjustment status to `pending_approval` rather than applying it immediately.
6. WHILE an adjustment is in `pending_approval` status, THE System SHALL NOT apply the quantity_delta to the Inventory_Balance.
7. WHEN an Owner approves a pending adjustment, THE System SHALL apply the quantity_delta to the Inventory_Balance and transition the adjustment status to `approved`.
8. WHEN an Owner rejects a pending adjustment, THE System SHALL discard the adjustment, set its status to `rejected`, record the rejecting user_id and timestamp, and notify the submitting user in the in-app feed.
9. THE System SHALL allow export of the full adjustment log filtered by date range, reason code, user, and SKU.

#### Phase 2 Enhancements
- Configurable approval thresholds per reason code rather than a single global threshold.
- Bulk adjustment upload via CSV for large-scale corrections.

---

### Requirement 6: Stock Counts and Audits

**User Story:** As an Owner or Staff, I want to perform cycle counts and full audits using the mobile app, so that physical stock is reconciled against the system and variances are documented.

#### Acceptance Criteria

1. THE App SHALL support two count types: `cycle_count` (a partial count of a selected subset of SKUs) and `full_audit` (all active SKUs at a Location).
2. WHEN a user starts a count session, THE System SHALL record the session start time and the Inventory_Balance snapshot for each SKU in the count scope at the moment the session is initiated.
3. WHEN a user scans a Barcode or manually selects a SKU during a count, THE App SHALL present the SKU name and allow the user to enter the counted physical quantity; THE App SHALL NOT display the system's expected quantity until the user submits the counted quantity, to avoid bias.
4. WHEN a user submits a counted quantity that differs from the snapshot balance, THE System SHALL calculate the variance as `counted_quantity - snapshot_balance` and display the variance to the user for confirmation.
5. WHEN the user confirms a count submission for a SKU, THE System SHALL create a Movement of type `count_correction` with quantity_delta equal to the variance and update the Inventory_Balance.
6. IF the user cancels a count session before submitting all scanned items, THEN THE System SHALL discard all unsubmitted count entries and restore the Inventory_Balance to the pre-count state for any items already submitted in that session; THE System SHALL warn the user before discarding.
7. WHEN a count session is completed, THE System SHALL generate a count summary showing: total SKUs counted, total variance units, total variance value, count of SKUs with positive variance, count of SKUs with negative variance, and the user who performed the count.
8. THE System SHALL retain all count sessions and their line-level variance records for audit drill-down.
9. WHEN the App is offline during a count session, THE App SHALL continue accepting scans and quantities locally; WHEN connectivity is restored, THE System SHALL process the queued count submissions in the order they were recorded.

#### Phase 2 Enhancements
- AI_Assistant-recommended Cycle_Count schedules based on shrinkage patterns and ABC classification.
- Multi-user simultaneous count sessions with partition-by-aisle assignment.

---

### Requirement 7: Barcode and SKU Management

**User Story:** As an Owner or Staff, I want to scan product barcodes with the device camera and have the app reliably resolve the product, so that all inventory workflows are fast and hands-free.

#### Acceptance Criteria

1. THE App SHALL use the device camera to scan barcodes in formats including UPC-A, UPC-E, EAN-13, EAN-8, Code 128, Code 39, QR Code, and Data Matrix.
2. WHEN a Barcode is scanned and matched to a Product in the System, THE App SHALL display the Product name, SKU, current Inventory_Balance, and relevant action options within 1 second of a successful scan.
3. WHEN a scanned Barcode is not found in the System, THE App SHALL prompt the user to create a new Product record and associate the scanned Barcode with it.
4. IF a Barcode is unreadable by the scanner, THE App SHALL provide a manual lookup fallback allowing the user to search by product name, SKU, or partial barcode string.
5. THE System SHALL enforce that each Barcode value is unique within a Business; IF a user attempts to assign an already-registered Barcode to a different SKU, THEN THE System SHALL reject the assignment and display a conflict message identifying the existing Product.
6. THE System SHALL support multiple Barcodes per Product to handle products with alternate UPCs, pack barcodes, and case barcodes.
7. THE System SHALL support Product Variants (e.g., single-unit vs. 6-pack) where each Variant has its own Barcode, SKU, and unit quantity multiplier; WHEN a case Barcode is scanned during receiving, THE System SHALL expand the quantity by the Variant multiplier.
8. WHEN a Product record is created or updated, THE System SHALL allow the Owner to attach a product image stored in Supabase Storage and a reference to the supplier's product catalog entry.

#### Phase 2 Enhancements
- Bulk product import via CSV with barcode, SKU, name, category, and cost columns.
- GS1 GTIN lookup to auto-populate product details from a public barcode database.

---

### Requirement 8: Purchase Orders and Reordering

**User Story:** As a Purchasing_User or Owner, I want to create, review, and issue purchase orders — including AI-suggested ones — so that replenishment is timely and well-documented.

#### Acceptance Criteria

1. THE System SHALL support the following PO statuses in order: `draft` → `submitted` → `partially_received` → `received`; a PO MAY also be set to `cancelled` from `draft` or `submitted`.
2. WHEN a user creates a PO, THE App SHALL allow the user to select a Supplier, add PO_Lines (each with SKU, ordered_quantity, unit_cost, and expected_delivery_date), and save the PO as `draft`.
3. WHEN a user submits a PO (transitions from `draft` to `submitted`), THE System SHALL record the submitting user_id, submitted_at timestamp, and lock the PO from further editing unless the user explicitly reopens it.
4. THE System SHALL store receipt documents and delivery notes as file attachments in Supabase Storage, linked to the PO record.
5. WHEN the AI_Assistant generates a suggested PO, THE System SHALL create it in `draft` status with a `source: ai_suggested` flag and populate each PO_Line with the suggested order quantity and a plain-language rationale string explaining why that quantity was recommended.
6. THE App SHALL display the rationale for each AI-suggested PO_Line in plain language accessible to a non-technical store owner (e.g., "Sales velocity: 12 units/day. Current stock: 10 units. Lead time: 3 days. Recommended order: 50 units to cover 4 weeks of demand with safety buffer.").
7. THE System SHALL enforce minimum order quantities (MOQ) and case-pack rounding per Supplier and SKU when calculating suggested order quantities; THE App SHALL display a warning when a user manually enters a quantity below the MOQ.
8. WHEN a Purchasing_User or Owner accepts a Recommendation of type `reorder`, THE System SHALL create a draft PO pre-populated with the recommended SKUs, quantities, and default Supplier.
9. WHEN a Purchasing_User or Owner rejects a Recommendation, THE System SHALL record the rejection with a reason code selected by the user (`already_ordered`, `not_needed`, `wrong_quantity`, `other`) and use this feedback to adjust future recommendations for that SKU.
10. THE System SHALL support partial receives against a PO as specified in Requirement 2.

#### Phase 2 Enhancements
- Email or PDF PO generation for sending to suppliers who do not use a digital portal.
- Supplier portal for direct PO acknowledgement and delivery confirmation.

---

### Requirement 9: Role-Based Access Control

**User Story:** As an Owner, I want to control what each team member can see and do in the app, so that sensitive operations and data are protected.

#### Acceptance Criteria

1. THE System SHALL enforce four roles: `owner`, `staff`, `purchasing`, and `accountant`; each authenticated user SHALL have exactly one role per Business.
2. THE System SHALL enforce the following permission matrix via Supabase RLS policies:

   | Capability | Owner | Purchasing | Staff | Accountant |
   |---|---|---|---|---|
   | View inventory & dashboard | ✅ | ✅ | ✅ | ✅ |
   | Scan barcodes & receive stock | ✅ | ✅ | ✅ | ❌ |
   | Create/submit adjustments | ✅ | ✅ | ✅ | ❌ |
   | Approve adjustments | ✅ | ❌ | ❌ | ❌ |
   | Create/edit POs | ✅ | ✅ | ❌ | ❌ |
   | Submit/cancel POs | ✅ | ✅ | ❌ | ❌ |
   | Manage products & SKUs | ✅ | ✅ | ❌ | ❌ |
   | Configure reorder settings | ✅ | ✅ | ❌ | ❌ |
   | View reports & export | ✅ | ✅ | ❌ | ✅ |
   | Manage users & roles | ✅ | ❌ | ❌ | ❌ |
   | Configure integrations | ✅ | ❌ | ❌ | ❌ |
   | View AI recommendations | ✅ | ✅ | ❌ | ❌ |

3. WHEN a user attempts an action for which their role lacks permission, THE App SHALL display a clear, non-technical access-denied message and SHALL NOT expose any data the role is not permitted to see.
4. THE System SHALL enforce all permissions at the database layer via RLS in addition to UI-level enforcement, so that bypassing the App does not grant unauthorized access.
5. WHEN an Owner invites a new user, THE System SHALL send the invitation via email; the invited user SHALL complete registration before accessing the Business.
6. WHEN an Owner removes a user from the Business, THE System SHALL immediately revoke all active sessions for that user scoped to that Business.

#### Phase 2 Enhancements
- Custom roles with granular permission toggles.
- Multi-location role scoping (e.g., Staff restricted to a single Store).

---

### Requirement 10: Dashboard and Reports

**User Story:** As an Owner or Accountant, I want a mobile-first dashboard with key inventory KPIs and drill-down reports, so that I can quickly understand the health of my business from my phone.

#### Acceptance Criteria

1. THE App SHALL display a Dashboard on first login (after authentication) containing the following KPI cards: total stock on hand (units), total inventory value (cost), low-stock SKU count, stockout SKU count, stockout risk count (SKUs projected to stock out within lead time), sell-through rate (last 30 days), shrink/adjustment rate (last 30 days), and synced gross sales (last 30 days).
2. WHEN a user taps a KPI card on the Dashboard, THE App SHALL navigate to a drill-down report view showing the underlying data with filtering and sorting options.
3. THE App SHALL include the following report views: Stock On Hand, Inventory Valuation, Low-Stock and Stockout Risk, Sales Velocity by SKU, Dead Stock / Slow Movers (no sales in last 60 days), Shrinkage and Adjustment Log, Purchase Order History, and Inventory Movement History (Ledger view).
4. WHEN a user applies a filter to a report, THE System SHALL return filtered results within 3 seconds for datasets up to 10,000 Ledger entries.
5. THE App SHALL allow filtering all reports by: date range, product category, supplier, SKU, and movement type.
6. THE App SHALL allow the Owner and Accountant to export any report as a CSV file downloadable from the device.
7. THE App SHALL display inventory value using the weighted average cost method; THE System SHALL recalculate the weighted average cost when a receive Movement is recorded.
8. THE App SHALL display a Forecasted Reorder Risk view showing SKUs projected to fall below Reorder_Point within their Lead_Time_Days, based on recent sales velocity calculated from Ledger sale Movements.

#### Phase 2 Enhancements
- Web-based admin console for larger-screen report analysis.
- Scheduled email report delivery for Owner and Accountant roles.
- Year-over-year and seasonality comparison charts.

---

### Requirement 11: AI Assistant and Recommendations

**User Story:** As an Owner or Purchasing_User, I want the app to proactively suggest purchase orders, flag anomalies, and recommend inventory actions in plain language, so that I can make better decisions without needing inventory expertise.

#### Acceptance Criteria

1. THE AI_Assistant SHALL generate Recommendations of the following types: `reorder` (replenish a SKU), `dead_stock` (reduce or clear slow-moving inventory), `count_priority` (count a SKU with suspected shrinkage), and `anomaly` (unusual sales pattern or stock discrepancy detected).
2. WHEN the AI_Assistant generates a Recommendation, THE System SHALL persist it to a `recommendations` table with fields: `recommendation_id`, `business_id`, `recommendation_type`, `sku_id`, `rationale_text`, `confidence_level` (`heuristic` or `forecast`), `status` (`pending`, `accepted`, `rejected`, `expired`), `created_at`, and `expires_at`.
3. THE AI_Assistant SHALL label every Recommendation with a `confidence_level` of `heuristic` for rule-based suggestions and `forecast` for statistically derived suggestions; THE App SHALL display this label in the UI so users understand the basis of each recommendation.
4. WHEN a user accepts a `reorder` Recommendation, THE System SHALL create a draft PO as specified in Requirement 8, Criterion 8.
5. WHEN a user rejects a Recommendation, THE System SHALL record the rejection reason as specified in Requirement 8, Criterion 9.
6. THE AI_Assistant SHALL calculate reorder suggestions using the following inputs: current Inventory_Balance, Reorder_Point, Safety_Stock, Lead_Time_Days, 30-day sales velocity (units/day derived from Ledger), and any open PO quantities for the SKU; THE rationale_text SHALL reference all inputs used.
7. THE AI_Assistant SHALL flag a SKU as dead stock WHEN the SKU has had zero sale Movements in the last 60 days AND the Inventory_Balance is greater than zero.
8. THE AI_Assistant SHALL flag an anomaly WHEN the daily sales velocity for a SKU in the last 7 days exceeds 3 standard deviations above the 90-day average sales velocity for that SKU.
9. THE AI_Assistant SHALL flag an anomaly WHEN the Ledger shows adjustment Movements of type `theft` or `spoilage` for a SKU totalling more than 10% of the 30-day received quantity for that SKU.
10. THE App SHALL surface pending Recommendations in the Dashboard and in a dedicated Recommendations feed; Recommendations older than 30 days with `pending` status SHALL be automatically transitioned to `expired`.
11. THE System SHALL distinguish in all UI and data labels between rules-based (`heuristic`) and forecast-based (`forecast`) Recommendations; THE App SHALL NEVER present a heuristic recommendation as an ML or AI prediction.

#### Phase 2 Enhancements
- Integration with an external ML model service (e.g., AWS Forecast, Vertex AI) for SKU-level demand forecasting.
- Seasonality detection using year-over-year Ledger data once 12+ months of history is available.
- Personalized recommendation tuning based on accumulated accept/reject feedback per SKU.

---

### Requirement 12: Authentication and Multi-Tenancy

**User Story:** As an Owner, I want secure authentication and tenant isolation, so that my business data is never accessible to users of other businesses.

#### Acceptance Criteria

1. THE System SHALL use Supabase Auth for all user authentication; supported methods in MVP are email/password and magic link (passwordless email).
2. WHEN a user authenticates, THE System SHALL issue a JWT containing the user's `business_id` and `role`; all subsequent API and database calls SHALL be authorized using this JWT.
3. THE System SHALL apply RLS policies on every table containing business data such that a query authenticated with `business_id = X` can only access rows where `business_id = X`.
4. IF a request is made without a valid JWT or with an expired JWT, THEN THE System SHALL return a 401 Unauthorized response and THE App SHALL redirect the user to the login screen.
5. THE System SHALL support a schema design where each Business has a `business_id` UUID as a top-level tenant key; all child entities (stores, users, products, movements, POs, etc.) SHALL reference `business_id` and be covered by RLS policies.
6. THE App SHALL support session persistence across App restarts using Supabase Auth's secure token storage; the user SHALL remain authenticated until the token expires or the user explicitly signs out.
7. WHEN a user signs out, THE App SHALL clear all locally cached data and tokens and navigate to the login screen.

#### Phase 2 Enhancements
- SSO via OAuth providers (Google, Apple) for faster onboarding.
- Two-factor authentication (TOTP) for Owner accounts.

---

### Requirement 13: Offline-Aware UX and Sync

**User Story:** As a Staff member working in a store with unreliable connectivity, I want the app to continue functioning for critical workflows when offline, so that receiving and counting are never blocked by network issues.

#### Acceptance Criteria

1. THE App SHALL detect network connectivity status using the device's network state API and display a persistent offline banner when the device has no connectivity.
2. WHEN the App is offline, THE App SHALL allow the following workflows to continue using locally queued actions: barcode scan and product lookup (against a locally cached product catalog), stock receive (queued to Offline_Queue), stock count (queued to Offline_Queue), and manual stock adjustment (queued to Offline_Queue).
3. THE App SHALL cache the product catalog (SKU, name, barcode, current balance snapshot) locally at app startup and refresh the cache when connectivity is restored.
4. WHEN the App transitions from offline to online, THE System SHALL process the Offline_Queue in chronological order and sync each pending action; THE App SHALL display a sync progress indicator during this process.
5. WHEN an Offline_Queue action fails to sync due to a conflict or server error, THE App SHALL notify the user with a specific error message for each failed action and allow the user to retry or discard each action individually.
6. THE App SHALL use optimistic UI updates for actions that are safe to show immediately (e.g., showing a pending receive in the product balance view with a "pending sync" indicator) and SHALL clearly differentiate confirmed versus pending data.
7. THE System SHALL guarantee that an action processed from the Offline_Queue cannot be applied more than once, using an Idempotency_Key generated client-side at the time the action is queued.

#### Phase 2 Enhancements
- Background sync when the App is not in the foreground, using Expo BackgroundFetch.
- Configurable offline cache TTL per data type.

---

### Requirement 14: Data Architecture and Schema

**User Story:** As the development team, I want a well-defined Supabase Postgres schema with clear entity relationships and RLS policies, so that the system is maintainable, secure, and scalable to multi-location from day one.

#### Acceptance Criteria

1. THE System SHALL implement the following core tables at minimum: `businesses`, `locations`, `users` (extending Supabase auth.users), `user_roles`, `suppliers`, `products`, `product_barcodes`, `product_variants`, `inventory_balances`, `inventory_movements` (the Ledger), `purchase_orders`, `purchase_order_lines`, `stock_count_sessions`, `stock_count_lines`, `alerts`, `recommendations`, `recommendation_feedback`, `square_sync_events`, `offline_queue_log`.
2. THE System SHALL apply RLS policies on every table listed in Criterion 1 such that all row access is gated by `business_id` matching the authenticated user's JWT claim.
3. THE System SHALL implement a Postgres function `get_inventory_balance(sku_id, location_id)` that computes balance from the Ledger and returns the same value as the materialized `inventory_balances` table; this function SHALL be used in automated consistency checks.
4. THE System SHALL include a database migration strategy using versioned migration files; each migration SHALL be idempotent and reversible where possible.
5. THE System SHALL include seed data representing a sample convenience-store product catalog with at least 20 SKUs, two Suppliers, a sample PO, and sample Ledger movements covering 30 days of activity for use in development and QA.
6. THE System SHALL use `uuid` primary keys on all tables; auto-incrementing integer keys SHALL NOT be used on tenant-owned tables.
7. THE System SHALL define Postgres indexes on: `inventory_movements(business_id, sku_id, location_id, created_at)`, `inventory_movements(reference_id)`, `purchase_orders(business_id, status)`, `alerts(business_id, status, sku_id)`, and `square_sync_events(square_event_id)`.

#### Phase 2 Enhancements
- Partition `inventory_movements` by `business_id` and `created_at` for businesses with high transaction volumes.
- Read replica routing for reporting queries.

---

### Requirement 15: Non-Functional Requirements

**User Story:** As an Owner, I want the app to be fast, reliable, and secure, so that it doesn't slow down my team or expose my business data.

#### Acceptance Criteria

1. THE App SHALL render the Dashboard initial view within 2 seconds on a device connected to a 4G LTE network under normal load conditions.
2. WHEN a barcode scan produces a successful match, THE App SHALL display the product detail and action options within 1 second.
3. THE System SHALL maintain inventory data integrity such that the ledger-balance consistency invariant (Requirement 1, Criterion 7) holds at all times; THE System SHALL expose a health-check endpoint that an Owner can trigger to verify consistency across all SKUs.
4. THE System SHALL log all authentication events, all role-permission-denied events, and all inventory-affecting operations to an audit log accessible to the Owner.
5. THE System SHALL not expose Square API credentials, Supabase service role keys, or any other privileged secrets to the mobile client under any circumstances.
6. THE App SHALL display a clear, user-friendly error message for all error conditions and SHALL NOT display raw stack traces, database errors, or internal system details to end users.
7. THE App SHALL support iOS 15+ and Android 10+ as minimum OS targets via the Expo managed workflow.
8. THE System SHALL enforce HTTPS for all client-to-Supabase and client-to-Edge-Function communications; plain HTTP SHALL NOT be used.
9. WHEN the System performs a Square API reconciliation or catalog sync operation, THE Edge_Function SHALL complete the operation within 30 seconds or time out and log a failure event for operator review.
10. THE System SHALL be designed so that adding a second Location for a Business requires no schema migration and only the addition of a new `locations` row and corresponding RLS policy adjustments.

---

## Open Questions

The following questions remain open and should be resolved before detailed design begins:

1. **Square OAuth flow**: Should the Owner complete Square OAuth connection within the mobile app (using an in-app browser) or via a separate web-based setup screen? The mobile OAuth redirect URI handling in Expo requires careful configuration.
2. **Offline product catalog size limit**: For stores with large catalogs (1,000+ SKUs), what is the acceptable local cache size on device? Should the cache be a full catalog snapshot or a most-recently-used subset?
3. **Cost accounting method**: Weighted average cost is specified for MVP. Should FIFO or LIFO be considered for a future phase, and does this affect the Ledger schema design now?
4. **Supplier contact workflow**: Should the app support sending a PO to a supplier via email directly from the app in MVP, or is PDF export sufficient?
5. **Variance threshold for anomaly alerts**: The 3-standard-deviation threshold in Requirement 11 is an initial heuristic. What feedback mechanism should calibrate this threshold per SKU, and should it be Owner-configurable in MVP?
6. **Barcode scanner SDK selection**: `expo-camera` with `expo-barcode-scanner` vs. a third-party SDK (e.g., Scanbot, Dynamsoft). Performance and licensing cost tradeoffs should be evaluated before implementation.
