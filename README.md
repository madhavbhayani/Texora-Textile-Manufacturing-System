# Texora

Texora is a textile manufacturing management system. The React client lives at the repository root; the CommonJS Express API and PostgreSQL migration runner live in `backend/`.

## Frontend

```sh
npm install
npm run dev
npm run build
npm run lint
npm test
```

Set `VITE_API_URL` in a root `.env` file if the backend is not at `http://localhost:5000`. It should be the backend origin without `/api`.

## Backend and database

Use Node.js 20 or newer. Copy `backend/.env.example` to `backend/.env`, set the PostgreSQL connection and generate a unique `JWT_ACCESS_SECRET` (at least 32 random bytes). The checked-in ignore rules exclude `backend/.env`.

```sh
cd backend
npm install
npm run db:migrate
npm start
```

`npm start` checks the database connection, runs pending migrations, and only then opens the HTTP listener. To develop with Node's watch mode, use `npm run dev`. The API defaults to port 5000; the Vite origin defaults to `http://localhost:5173`.

`backend/database/migrations/001_initial_schema.sql` is derived from the provided Texora PostgreSQL setup (`texora_textile_manufacturing_fixed_v2.sql`) with only its outer `BEGIN`/`COMMIT` removed. A fresh database executes it. A database with existing Texora schemas is checked for required schemas, core auth/buyer columns and types, and all six active roles; if it passes, the migration is recorded as `BASELINED` without executing the DDL. Partial/incompatible databases stop startup. Back up data and resolve any reported missing objects against the source SQL before retrying; never clear `public.migrations` to force a rerun. Applied migration files are checksum-protected: create a new numbered migration instead of editing one already applied.

`002_product_catalog.sql` applies the additive catalogue schema and seed SKUs to an initialized Texora database. The Node migration runner applies it after `001` (including for an existing database that was baselined). A fresh pgAdmin setup should run the fixed v2 setup first and then this additive migration, or start the API once to let the runner apply it. Seed prices, costs, BOM quantities and image URLs are demo values; Owners can update them through the catalogue APIs.

`003_remove_buyer_tax_ids.sql` removes the unused `master.buyers.gst_no` and `pan_no` columns. Existing values in those two fields are discarded when this migration runs.

### Authentication API

- `POST /api/buyers/signup`
- `POST /api/buyers/login`
- `GET /api/auth/me`
- `GET /api/auth/csrf`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/health`

### Product catalogue and orders

Public catalogue endpoints return only active and published products from `reporting.product_catalog`, which excludes manufacturing cost and BOM data:

- `GET /api/products?q=&category=&weave=&minGsm=&maxGsm=&limit=&offset=`
- `GET /api/products/:productId`

Buyer endpoints require `Authorization: Bearer <accessToken>` and use the verified user/session to scope buyer data:

- `POST /api/orders` — create an order using saved shipping address, product, colour, quantity in metres, and configured customer attributes. The server/database supplies price, tax, buyer identity and accepted status.
- `GET /api/orders/my` and `GET /api/orders/:orderId` — list or view only the buyer's own orders.
- `GET /api/orders/addresses` — list saved shipping addresses.

Owner endpoints require an active `OWNER` access token:

- `POST /api/products`, `PATCH /api/products/:productId`, `PATCH /api/products/:productId/publish`, `PATCH /api/products/:productId/archive`
- `GET /api/products/owner` and `GET /api/products/owner/:productId` for draft products and owner-only cost, BOM and configuration details
- `PUT /api/products/:productId/colours`, `PUT /api/products/:productId/bom`, `PUT /api/products/:productId/attributes`
- `GET /api/products/colours`, `/yarns`, and `/attribute-definitions` for owner form choices
- `GET /api/orders` for factory-wide order listing

The customer UI is available at `/customer`. It loads its catalogue from the API, submits orders to the buyer endpoint, and displays server-returned order numbers and tracking status. Product catalog and order integration tests that require PostgreSQL need a separate disposable database; the existing and new backend unit tests do not apply migrations or write to the database configured in local `.env`.

Access tokens are returned in the response and held in frontend memory; they are not persisted in browser storage. Refresh tokens are opaque, rotated, stored only as SHA-256 hashes in `auth.sessions`, and sent as `HttpOnly` cookies. Refresh/logout require the CSRF token supplied by login/signup or `GET /api/auth/csrf`. Configure `CORS_ORIGIN` as an exact comma-separated allowlist. For cross-site frontend/API deployments, use HTTPS with `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none`; browser cookie and CORS credential settings must both allow the specific frontend origin.

Tests run without a database using Node's test runner (`cd backend && npm test`). Database migration and end-to-end auth tests require a separate disposable PostgreSQL test database. The additive Owner invoice review migration was applied to the configured local database with the normal migrator; no database integration tests were run.
# Internal Store Manager workspace

The Store Manager workspace is available at `/store-manager` after signing in with an active `STORE_MANAGER` or `OWNER` account. Its APIs are mounted under `/api/store-manager`; role checks are enforced by the backend.

The Store Manager navigation places Supervisor Handoffs fourth. Customer order lines and BOM stock requirements load directly into that screen; assigning a Supervisor creates the pending handoff. Supervisors can approve when material is available or put it on hold and approve it later. Receiving, supplier invoices and payments are combined under `/store-manager/procurement`; invoices use PO rates and tax, and the server derives outstanding payment amounts.

Apply the additive `006_store_manager_workflow.sql` migration using the normal startup migrator or run `npm run db:migrate` from `backend/` before launching the API. Development-only demo credentials can be seeded with PowerShell from `backend/`:

```powershell
$env:NODE_ENV = 'development'
$env:SEED_DEMO_USERS = 'true'
npm run seed:dev
```

This creates `storemanager@gmail.com` with temporary password `admin123`; the account must change that password on first sign-in. The seed refuses to run unless both development safeguards are enabled, and it refuses to change an existing account with a different role. Never enable this seed in production.

Start the API with `npm run dev` from `backend/` and the frontend with `npm run dev` from the repository root. The customer portal and its routes remain available.

# Worker workspace

Workers sign in through the existing login page and use the shared internal layout at `/worker`. The workspace includes overview, attendance, assigned jobs, machine operations, production logs, wage statements and profile views. Worker APIs are mounted at `/api/worker` and require an active `WORKER` session; record ownership is always resolved from the authenticated account. Machine start, pause and completion call the existing PostgreSQL production routines. Worker log retries are idempotent after migration `011_worker_production_log_idempotency.sql`; explicit Supervisor unassignments are tracked separately from pauses after migration `012_worker_assignment_release_marker.sql`.

Apply pending migrations with `npm run db:migrate` from `backend/` (or start the backend, which runs migrations at startup). The Worker profile is read-only for HR-managed identity, skill, shift and pay configuration. Workers can check in/out for their configured active default shift, and can see only their own attendance, wage records and submitted production logs. Optional roll records are created with a production log and start in the database's `PENDING_QC` state.

The local demo account seed is opt-in and does not change existing credentials:

```powershell
cd backend
$env:NODE_ENV = 'development'
$env:SEED_DEMO_USERS = 'true'
$env:DEMO_WORKER_WAGE_TYPE = 'DAILY'
$env:DEMO_WORKER_DAILY_RATE = 'REPLACE_WITH_APPROVED_LOCAL_RATE'
npm run seed:worker
```

Choose the wage type and rate approved for your local test database; the seed refuses to guess one. A newly created `worker@gmail.com` account uses temporary password `admin123`, stores only a bcrypt hash, and requires a password change at first sign-in. The account and worker profile are created atomically. Never enable demo seeds in production.

# Dispatch Officer workspace

The Dispatch Officer workspace is available at `/dispatch` after signing in with an active `DISPATCH_OFFICER` account. Its APIs are mounted at `/api/dispatch` and require the dispatch role (or Owner access).

For local development, opt in to the demo account seed from `backend/`:

```powershell
$env:NODE_ENV = 'development'
$env:SEED_DEMO_USERS = 'true'
npm run seed:dispatch
```

The sample login is `dispatch@gmail.com` with temporary password `admin123`. The seed stores a bcrypt hash and requires a password change at first sign-in. It leaves existing Dispatch Officer accounts unchanged and refuses to alter an account with a different role. Never enable demo seeds in production. You can override the sample email, name, and password with `DEMO_DISPATCH_EMAIL`, `DEMO_DISPATCH_FULL_NAME`, and `DEMO_DISPATCH_PASSWORD`.

# Owner workspace

The Owner workspace uses the shared internal layout at `/owner` and is protected by the active `OWNER` role. Owner APIs are mounted at `/api/owner`; each route also checks its required `auth.role_permissions` permission. Factory-wide dashboard and operational summaries use the existing reporting views and preserve the distinction between supplier invoices awaiting review and approved payables.

The workspace includes the executive dashboard, customers and orders, catalogue/BOM, inventory, suppliers, purchasing, goods receipts, supplier invoice approvals, supplier payments, production, machines, quality, dispatch, customer invoices, finance, workforce, reports, users/roles, audit, notifications and supported settings. Supplier invoice approval is maker-checker controlled, validates its PO/receipt lines, records a required reason and writes the approver into the invoice. Payment creation requires an approved invoice and enforces the remaining balance; confirming a payment and role or setting changes are recorded in the audit log. Settings editing is restricted to supported operational values and validates their ranges.

Migration `013_owner_invoice_reviews.sql` adds the durable invoice review history and database approval guard. It is additive and is applied by backend startup or `npm run db:migrate` from `backend/`. Owner-specific unit tests are in `backend/test/owner-module.test.js`.

# Worker account email

The Supervisor creates worker accounts with a generated temporary password. The password is sent to the worker's required email address and is never returned to the browser. Workers must set a new password at first sign-in. The backend initializes and verifies its pooled Gmail SMTP transport at startup.

Configure `GMAIL` with the sender Gmail address and `APP_PASSWORD` with a Google App Password in `backend/.env`. App Passwords may be pasted with spaces. Keep `backend/.env` private and use `backend/.env.example` only as a variable template. If SMTP is not available, account creation is rolled back and the Supervisor sees a sanitized delivery error.
