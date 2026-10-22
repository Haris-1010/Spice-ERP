# Spice Manager — مصالحہ مینیجر

Offline-first business management for a spice company: bulk purchasing → packing into retail packets →
wholesale/retail sales → shop delivery → payments, ledgers and profit. English and Urdu (full right-to-left UI
and Urdu/English/bilingual invoices), product images, installable PWA.

| Layer | Technology |
|---|---|
| Frontend | Angular 19 (standalone components, signals), PWA service worker |
| Offline DB | IndexedDB via Dexie 4 — versioned schema, durable outbox queue |
| Backend | ASP.NET Core 8 Web API, JWT auth, role permissions, rate limiting, Swagger |
| Database | PostgreSQL 14+ |
| Data access | EF Core 8 (Npgsql) for CRUD and transactional posting · Dapper for dashboards/reports |

```
spice-erp/
├─ database/schema.sql            PostgreSQL schema v1 (43 tables, constraints, append-only ledgers, stock views)
├─ database/migrations/           NNN_*.sql scripts applied automatically after v1
├─ backend/SpiceErp.Api/          ASP.NET Core 8 API
│  ├─ Data/                       EF Core entities, DbContext, initializer/seed
│  ├─ Services/                   Business rules: Posting (stock/ledgers/cash), Purchase, Packing, Sales,
│  │                              Finance, Delivery, Inventory, Customer, Sync, Auth
│  ├─ Reports/ReportQueries.cs    Dapper reports (dashboard, P&L, stock, aging, statements, cash book…)
│  └─ Controllers/                REST endpoints (/api/…)
├─ frontend/                      Angular PWA
│  └─ src/app/core/               i18n (EN/UR), Dexie DB, sync engine, local store (offline operations)
├─ tests/smoke_test.py            40-check API acceptance test (SRS §25 functional + sync)
├─ tests/e2e-offline.mjs          Browser test: offline invoice → reload → print → reconnect → syncs once
├─ scripts/backup.sh, restore.sh  PostgreSQL backups and verified restore
└─ Dockerfile, docker-compose.yml One-command deployment
```

---

## 1. Run it

### Option A — Docker (recommended)
```bash
cp .env.example .env        # set DB_PASSWORD, JWT_KEY (32+ chars), ADMIN_PASSWORD
docker compose up -d --build
```
Open **http://localhost:8080**, sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
The database schema is created automatically on first start, with a starter catalogue
(7 spices × 20/50/100/200 g, pouches and labels — **no stock and no transactions**; turn off with `DEMO_CATALOG=false`).

### Option B — local development
Requirements: .NET 8 SDK, Node 20+, PostgreSQL 14+.
```bash
# database
createdb spice_erp

# API  (http://localhost:5080, Swagger at /swagger)
cd backend/SpiceErp.Api
dotnet user-secrets init
dotnet user-secrets set "Jwt:Key" "a-long-random-secret-of-at-least-32-characters"
dotnet user-secrets set "ConnectionStrings:Default" "Host=localhost;Database=spice_erp;Username=postgres;Password=..."
dotnet user-secrets set "Seed:AdminPassword" "ChangeMe123"
dotnet run --urls http://localhost:5080

# frontend  (http://localhost:4200 — proxies /api and /uploads to :5080)
cd frontend
npm install
npx ng serve
```

### Deploy to blitz.cloud + Neon

The included `Dockerfile` is ready for blitz.cloud. Create a Neon PostgreSQL database,
copy its pooled or direct connection string, then create a blitz.cloud app from this
GitHub project (or deploy the Docker image). Set these encrypted app environment
variables in blitz.cloud:

```text
ConnectionStrings__Default=<Neon connection string>
Jwt__Key=<random secret, at least 32 characters>
Seed__AdminUsername=admin
Seed__AdminPassword=<strong initial password>
Seed__BusinessName=My Spice Company
Cors__Origins__0=https://<your-app>.<your-name>.blitz.cloud
Swagger__Enabled=false
Uploads__Path=/data/uploads
```

Add persistent storage mounted at `/data/uploads` if product images must survive
restarts. Set the app port to `8080`; the container already listens on that port.
Neon connection strings normally include SSL settings; do not commit the string to
the repository.

### Deploy the frontend to Vercel

Vercel can host the Angular PWA separately. Create a Vercel project using this
repository and keep the root directory at the repository root. The included
`vercel.json` builds `frontend/` and publishes its browser output. Set this Vercel
environment variable for the Production environment:

```text
SPICE_API_BASE_URL=https://<your-api-app>.<your-name>.blitz.cloud
```

The build writes this value into a generated runtime config; it is not a secret.
Also add the final Vercel URL to the API's `Cors__Origins__0` (and keep only
trusted HTTPS origins). If the frontend is served by the Blitz container instead,
leave `SPICE_API_BASE_URL` empty and use the Blitz URL as the single origin.

Neon is the database in both layouts; Vercel should never receive
`ConnectionStrings__Default`, `Jwt__Key`, or admin credentials.
If `Seed:AdminPassword` is empty, a random owner password is generated and printed **once** in the API log.

> **HTTPS:** offline mode (service worker, IndexedDB encryption key) requires HTTPS in production
> (localhost is exempt). Put the container behind a TLS proxy (Caddy, nginx, a cloud load balancer) and set
> `PUBLIC_URL`. Set `Https__Redirect=true` if TLS terminates in Kestrel.

---

## 2. First steps for the owner
1. **Settings** → business name (English + Urdu), address, phone, logo, invoice terms (both languages).
2. **Products** → check spices, Urdu names, packet sizes and prices; upload a photo for each product.
3. **Users & Permissions** → create staff and give roles (Owner, Storekeeper, Packer, Salesperson, Delivery, Accountant).
4. **Suppliers → Purchases** → record bulk spice (kg) and packaging purchases.
5. **Packing & Production** → plan a packing order, then record good / rejected packets and loss.
6. **Customers → Sales & Invoices** → sell; print A4 or 80 mm thermal, in English, Urdu or both.
7. **Delivery Routes** → load pending invoices on a route, record each shop visit, reconcile at the end.

Each staff member signs in once on their device while online; after that the device works offline.

---

## 3. How the business rules work

**Units.** Bulk spice is stored as whole **grams**, finished stock as **packets**, packaging as **units** (all integers).
Money is `numeric(14,2)`; unit costs `numeric(18,6)`. Timestamps are UTC, displayed in Pakistan time.

**Stock ledger.** Every movement is a row in `InventoryTransactions` (buckets BULK / FINISHED / DAMAGED) or
`PackagingMaterialTransactions`, with its source document. Balances are always the sum of the ledger — there is no
editable "quantity" column. Ledger, cash and customer/supplier ledger tables are **append-only** (a database trigger
blocks UPDATE/DELETE); cancellations post reversal rows.

**Packing.** Bulk consumed = (good + rejected packets) × packet size + measured loss. Whatever is not consumed stays
in the batch — the system never assumes the planned quantity was produced. Rejected packets go to DAMAGED stock.
Packet cost = (spice at batch cost + packaging used + labour + overhead) ÷ good packets.

**Costing policy.** Bulk spice: specific batch cost (purchase price + allocated transport/tax − discount).
Finished packets and packaging: moving **weighted average**. Each invoice line stores its cost at the time of sale.

**Profit (labelled "estimate").** Net sales = invoices excl. tax − returns ·
COGS = cost at sale − cost of restocked returns · Gross profit = net sales − COGS ·
Net profit = gross profit − (expenses − labour/overhead already inside packet cost) − stock losses
(negative adjustments and damaged packets at cost). Receipts and supplier payments are never revenue or expense.

**Customer balances** come only from posted `CustomerLedgerEntries` (opening, invoice, receipt, return, refund,
cancellation). Receipts are allocated to invoices (preferred invoice first, then oldest) for aging.

**Returns.** GOOD packets go back to saleable stock at their original cost; DAMAGED / EXPIRED / WRONG_ITEM go to
DAMAGED stock. Settlement is customer credit or cash refund.

**Delivery.** Stock leaves when the invoice is posted. At a stop, undelivered packets are returned to stock
automatically (a delivery-origin return), so each packet is counted exactly once as delivered, returned or pending.

**Cancellations** (purchases, packing orders, invoices, receipts, payments, expenses) are reversals with a required
reason, and are refused when they would break stock history (e.g. cancelling a purchase whose stock was already used).

---

## 4. Offline-first design

What works offline: creating **invoices**, **customer receipts**, **expenses**, **sales returns**, **new/edited customers**,
**delivery stop updates**, viewing customers/products/stock/invoices, and **printing**. Office functions that change
shared stock directly (purchases, packing, adjustments, user management, reports) need a connection.

1. **Atomic local save.** Each operation is written in one IndexedDB transaction together with its outbox entry and
   the device number counter. The "saved" message appears only after that transaction commits.
2. **Honest status.** Every record shows *Saved on this device*, *Syncing*, *Synced with server*,
   *Sync failed — retry required*, *Conflict requires review* or *Rejected by server*.
3. **Numbers without collisions.** On first sign-in the server allocates a device prefix (`D01`, `D02`…).
   Offline numbers are `INV-D02-00017`, `RC-D02-…`, `EXP-…`, `RET-…`; the server rejects a number from another
   device's range. IDs are UUIDs generated on the device.
4. **Exactly-once sync.** Every outbox operation has an `opId`. The server stores it in `ProcessedIdempotencyKeys`
   *in the same database transaction* that posts the document. Retrying after a timeout returns the stored result —
   no duplicate invoice or payment. Business rejections are stored too, so retries are deterministic.
5. **Order & backoff.** Operations are pushed in creation order (a new customer before its invoice), 50 per request,
   with exponential backoff (5 s → 10 min). Nothing leaves the outbox until the server confirms it; interrupted pushes
   are retried on next start.
6. **No double counting.** Local stock/balance = last server snapshot + effects of operations not yet contained in a
   snapshot. After a pull, confirmed operations are flagged `included`.
7. **Conflicts.** The server is authoritative for stock and money. A real sale made offline is never thrown away:
   overselling, prices below minimum / stale prices (without discount permission) and credit-limit breaches are posted
   **and** recorded in `SyncConflicts` for the owner (**Synchronization** page). Customer edits use version numbers —
   an out-of-date edit is not applied and is flagged.
8. **Offline printing** renders entirely from IndexedDB.
9. **Security.** No secrets in the Angular build. The access token is stored encrypted with a non-extractable
   WebCrypto AES key; passwords are never stored. Owners can revoke a device; it is blocked the next time it connects
   (a device that never reconnects cannot be stopped remotely). Sign-out keeps unsynced records; "clear this device"
   is refused while unsynced records exist.

---

## 5. API overview
Swagger UI: `/swagger`. All routes need a Bearer token except `POST /api/auth/login`. Permissions are enforced on the
server with policies (`products.manage`, `sales.create`, `sales.discount`, `reports.financial`, …) and inside services.
Errors use one shape: `{ "error": { "code", "message", "details", "traceId" } }`.

`/api/auth` · `/api/users` · `/api/devices` · `/api/settings` · `/api/products` · `/api/product-categories` ·
`/api/packaging-materials` · `/api/suppliers` · `/api/purchases` (+ `/batches`) · `/api/inventory` (stock, ledger,
adjustments, counts, damage) · `/api/packing` · `/api/customers` · `/api/routes` · `/api/sales-orders` ·
`/api/sales-invoices` · `/api/sales-returns` · `/api/deliveries` · `/api/customer-receipts` · `/api/supplier-payments` ·
`/api/expenses` · `/api/cash-accounts` · `/api/uploads/{products|logo|attachments}` · `/api/reports/*` ·
`/api/sync/push` · `/api/sync/pull` · `/api/sync/status` · `/api/sync/conflicts` · `/api/audit-logs`

Product images: `POST /api/uploads/products` (multipart, JPG/PNG/WEBP ≤ 3 MB, content-checked, resized in the browser
to ≤ 800 px) → `{ url }`, stored on the product as `imageUrl`. Images are served from `/uploads` and cached by the
service worker for offline viewing.

---

## 6. Tests

```bash
# API acceptance test (fresh database with the demo catalogue)
python3 tests/smoke_test.py http://localhost:8080 admin <password>

# Browser offline test
npm i playwright && npx playwright install chromium
node tests/e2e-offline.mjs http://localhost:8080 admin <password> ./screenshots
```
`smoke_test.py` (40 checks): purchase 10 kg → pack 200 × 50 g with 198 good / 1 rejected / 40 g loss → stock and
costs → invoice with partial payment → balance from ledger → duplicate invoice prevention → returns (good vs damaged)
→ over-return blocked → offline sync push, retry with no duplicates, oversell conflict, foreign number range rejected
→ delivery partial with collection and reconciliation → expenses → P&L, cash book, statement, aging → invoice
cancellation reversal → audit log.

`e2e-offline.mjs`: sign in → go offline → create and print an invoice → reload the browser offline → invoice and
pending count survive → Urdu RTL print → reconnect → syncs **once** → forced retry creates no duplicate.

---

## 7. Backups
`scripts/backup.sh` (cron daily) writes a verified `pg_dump` and copies uploaded images; keep copies off the server.
`scripts/restore.sh <file>` restores into a separate database for checking before switching.
Suggested targets: RPO 24 h (or use managed PostgreSQL point-in-time recovery for minutes), RTO 1 h. Test a restore
monthly. Cloud backups do not replace device outboxes, and device outboxes do not replace server backups.

---

## 8. Notes and next steps
- **Schema management:** the schema is SQL-first (`database/schema.sql` + numbered scripts, applied at start-up),
  because append-only triggers, partial unique indexes and reporting views are clearer in SQL. EF Core maps the same
  tables; if you prefer `dotnet ef migrations`, scaffold a baseline migration from this schema.
- **Not included yet:** barcode **camera** scanning (keyboard/USB scanners already work in the invoice search box),
  customer signature capture (a "received by" name is recorded), packet label printing, multi-business tenancy UI
  (the data model already has `BusinessId` everywhere), automated unit-test project.
- Performance targets in the SRS should be validated on your real devices and data volume before go-live.
