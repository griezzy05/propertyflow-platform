# PropertyFlow

PropertyFlow is a role-based property-management web application. It includes a Node.js API and browser frontend for the platform developer, property owners, tenants, and agents. Property owner and delegated administrator are one operational role; the developer creates owner accounts directly.

Before continuing development, read [the final product design](docs/FINAL_SYSTEM_DESIGN.md). It defines the four-dashboard model, the owner/caretaker permission split, unit-level rent and lease rules, QR-code identity, tenant onboarding, phone-first behavior, and detailed Mermaid flowcharts for setup, access, notifications, and day-to-day property operations.

## Run locally

Requirements: Node.js 20 or newer.

```powershell
npm ci
npm start
```

Open `http://localhost:3000`. On a fresh local store, demo accounts use `Welcome123!`:

| Role | Email |
| --- | --- |
| Developer | `developer@propertyflow.local` |
| Owner | `owner@propertyflow.local` |
| Tenant | `tenant@propertyflow.local` |
| Primary agent | `agent@propertyflow.local` |
| Backup agent | `backup.agent@propertyflow.local` |

Do not use demo accounts or the local JSON store in production. Local data is written to `data/store.json`; set `PROPERTYFLOW_STORE_FILE` to change the path.

## Start automatically on a Windows laptop

Run `launch-propertyflow.bat` to start the local server in the background and open the app. It uses the existing `data/store.json`, explicitly selects local development mode, and binds only to `127.0.0.1` so the laptop does not expose the app to other devices on the network. Server output is written under `logs/`.

Run `install-propertyflow-startup.bat` once to add a shortcut to the current Windows account's Startup folder. The app will then start when that account signs in to Windows. This does not start it before Windows sign-in, and it does not configure a public/online service.

## Implemented workflows

- Role-scoped dashboards, developer-managed owner seat allocations, property and tenant onboarding, activation links, invitation reissue, and password reset.
- Account holders set their own password from a single-use invitation. Passwords are stored as scrypt hashes, never retrievable in plaintext; signed-in users can change their password, which revokes their sessions.
- Tenant requests, owner assignment, agent work-order updates, move-out tracking, per-user in-app notifications with unread/read controls, and payment history.
- Notification delivery and inbox access for developer, owner, agent, and tenant roles. Maintenance, urgent requests, account activation, lease changes, move-outs, work updates, and confirmed payments notify the relevant people; high-priority requests also alert the developer. Email/SMS delivery status is shown with each notification when providers are configured.
- Explicit unit records and lease history, generated unit codes, vacancy-aware tenant invitations, owner rent rolls, and effective-dated rent changes with audit entries.
- Owner-generated, printable/downloadable QR labels with hashed random tokens, secure role-checked scans, token replacement, and access audit entries.
- Private repair-photo and lease-document uploads through S3-compatible object storage. Downloads use short-lived signed URLs after server-side role and relationship checks.
- Bank/cash payment review and reconciliation, printable payment receipts, M-Pesa callback reconciliation, configurable rent and lease reminders with delivery history, and owner-scoped audit history.
- Owner/developer CSV exports for rent, arrears, occupancy, maintenance, and lease expiry. Spreadsheet formula-leading values are escaped.
- Email through Resend, SMS through Africa's Talking, and M-Pesa STK Push plus callback processing through Safaricom Daraja when configured.
- PostgreSQL-backed durable storage and a Render service blueprint.

## Phone access

PropertyFlow is a responsive, installable web app for Android and iPhone browsers as well as tablets and desktop computers. On small screens, dashboards stack into one column, role navigation scrolls horizontally, forms and actions remain touch-sized, and wide tables scroll within their own panels. Use the browser's Install app/Add to Home Screen action, or the install button when offered.

## Offline app and local/cloud data

The Windows laptop launcher runs the Node server against the laptop's `data/store.json`. Once the app is installed or loaded, its static interface and graphical system flow are cached, and normal data requests go to the server running on the same laptop. The laptop service must be running for sign-in and data changes; the Startup-folder launcher starts it when this Windows account signs in. The service worker never caches authenticated API responses or private tenant records.

Offline laptop data and the online Render database are intentionally separate. There is **no automatic synchronization** between them: use the laptop app for local/offline work and the hosted app for online/cloud work. Do not enter the same transaction in both systems expecting it to merge. Email, SMS, M-Pesa, and S3-compatible file storage need internet and their provider configuration; they cannot deliver/store remotely while offline. Browser push notifications are not implemented.

The graphical workflow is also available in the app at `/flowchart.svg` and is included in the offline shell cache. The detailed product and access-control diagrams remain in [the final system design](docs/FINAL_SYSTEM_DESIGN.md).

Public legal and customer-facing documents are available without signing in at `/documents`. Only the checked-in `docs/legal/` tree is served; internal operations, security, and technical documents remain on the laptop documentation package and are not exposed by the web service. The published documents are drafts and contain placeholders that must be completed and reviewed before production launch.

Provider credentials are optional in local development. Without them, the related delivery or payment action reports that it is unavailable; this does not verify provider connectivity. See `.env.example` for the supported environment variables. Never commit `.env` or paste credentials into source code.

## PostgreSQL

Set `DATABASE_URL` to a PostgreSQL connection string. The service applies `database/migrations/001_propertyflow_state.sql` at startup. The current migration stores application data in a single JSONB state row and serializes database-backed API operations with a row lock. Unit and lease collections are stored in that state, with legacy tenant records migrated at load time. This is a simple durable MVP strategy, not a normalized or high-throughput production data model.

Existing delegated admin accounts are converted to the Owner role when stored state is loaded. Their logins, tenant/property records, seat allocations, and linked owner portfolio are retained; there is no separate admin dashboard or `/api/admins` workflow. The developer creates owners directly, and each owner manages properties, tenants, and up to the allocated number of agents.

`DATABASE_SSL=true` enables encrypted PostgreSQL connections. Certificate verification is enabled by default. Render's internal PostgreSQL URL is only reachable by services in the same region. Render's internal TLS certificate is self-signed, so set `DATABASE_SSL_REJECT_UNAUTHORIZED=false` only when connecting to Render Postgres over its internal URL; TLS remains enabled. For an external URL, keep certificate verification enabled.

When running in production, the server requires `DATABASE_URL`, an HTTPS `APP_BASE_URL`, `SESSION_SECRET` (at least 32 characters), and bootstrap developer name/email/password (at least 16 characters for the password). Provider credentials are optional at startup; email, SMS, and M-Pesa actions remain unavailable until their respective credentials are configured. The first run of a fresh production database creates only the private developer account; production does not seed demo users. Keep database backups and securely store all provider secrets.

## Provider setup

- **Resend:** verify the sending domain and set `RESEND_API_KEY` and `EMAIL_FROM`.
- **Africa's Talking:** configure `AFRICASTALKING_USERNAME`, `AFRICASTALKING_API_KEY`, and, if enabled for the account, `AFRICASTALKING_SENDER_ID`.
- **Daraja:** configure the consumer key/secret, shortcode, passkey, and a high-entropy `DARAJA_CALLBACK_TOKEN`. Optionally set `DARAJA_RECIPIENT_NAME` to the exact registered business name so tenants can check it before approving an STK prompt; the public config exposes these non-secret recipient details, never the consumer credentials or passkey. The callback URL is generated from `APP_BASE_URL`. Keep `DARAJA_ENVIRONMENT=sandbox` until sandbox payments and callback delivery have been verified. Live transactions require Safaricom credentials and approval.
- **Private file storage:** configure `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, and `STORAGE_SECRET_ACCESS_KEY`. Set `STORAGE_ENDPOINT` and `STORAGE_FORCE_PATH_STYLE` for S3-compatible providers that need them (for example, Cloudflare R2). Use a private bucket with public access blocked; signed download URLs expire after one minute.
- **Reminders:** configure `REMINDER_SCHEDULER_ENABLED=true` to run the in-process 15-minute reminder sweep. The default rent offsets are 3 days before, on the due date, and 3 and 7 days after; lease-expiry reminders are 30, 7, and 0 days before expiry. Delivery requires the email/SMS providers above.

Production credentials, verified email/SMS delivery, object-storage provider behavior, public callback reachability, and real payment settlement have not been tested in this repository environment. Do not enable live payments until these have been independently tested.

## Deployment

`render.yaml` describes a Free Render web service in Frankfurt and leaves automatic deployment disabled. The existing Render PostgreSQL database is also in Frankfurt, so configure the service's `DATABASE_URL` with that database's **internal** connection URL. Set secret values directly in Render, never in source control or chat, and confirm the public HTTPS URL before deployment. Free services can sleep after inactivity and cold-start on the next request; review the [Render Free limits](https://render.com/docs/free). Keep M-Pesa in sandbox until the callback and reconciliation behavior is tested. Email, SMS, and Daraja credentials can be added later; the corresponding delivery and payment actions remain unavailable until configured.

## Checks

```powershell
npm run check
npm test
```

The API tests exercise role workflows, access boundaries, storage, reconciliation, reports, reminder configuration, and production configuration. The Playwright suite covers all five seeded account types, owner invitation/activation, a tenant-to-agent maintenance workflow, owner report downloads, and phone-sized layouts:

```powershell
npm run test:browser
```

Install the Playwright Chromium browser once with `npx playwright install chromium` if it is not already available. These tests do not replace provider sandbox testing, independent security review, database recovery testing, or production-readiness review.

The [final system design](docs/FINAL_SYSTEM_DESIGN.md) is the product roadmap and workflow reference. It includes the end-to-end account, property, tenant, maintenance, payment, move-out, access-control, and notification flows. Unit inventory, lease records, rent history, rent-roll views, secure QR labels, owner-role consolidation, a cross-role notification inbox, responsive phone layouts, an installable app shell, private file attachments, payment reconciliation and receipts, reminders, CSV reports, and audit history are implemented. Restricted caretaker permissions, provider delivery queues/retries, and browser push notifications remain future work.

## API

- `GET /api/health`, `GET /api/config`, `GET /api/dashboard`
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/auth/activate`, `POST /api/auth/password-reset`, `POST /api/auth/password-reset/complete`
- `POST /api/auth/change-password`
- `POST /api/owners` (developer only), `POST /api/agents` (owner only)
- `GET /api/notifications`, `PATCH /api/notifications/:id`, `PATCH /api/notifications/read-all`
- `GET /api/audit-logs`, `GET /api/reports?type=rent|arrears|occupancy|maintenance|lease-expiry`
- `GET /api/reminder-settings`, `PATCH /api/reminder-settings`, `GET /api/reminder-history`
- `POST /api/properties`, `POST /api/properties/:id/units`, `POST /api/units/:id/qr`, `GET /api/units/resolve/:token`
- `POST /api/tenants`, `POST /api/move-outs`
- `PATCH /api/leases/:id/rent` — owner-only effective-dated rent changes
- `POST /api/files`, `GET /api/files/:id` — protected uploads and short-lived private downloads
- `POST /api/requests`, `POST /api/requests/:id/assign`, `PATCH /api/work-orders/:id/status`
- `GET /api/payments`, `GET /api/payments/:id/receipt`, `POST /api/payments/manual`, `PATCH /api/payments/:id/reconcile`
- `POST /api/payments/mpesa/stk-push`

Protected API requests use a bearer token returned by login. QR label links lead to sign-in; QR codes do not expose tenant details publicly. Provider callback: `POST /api/payments/mpesa/callback/:token`.
