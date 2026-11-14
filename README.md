# PropertyFlow

PropertyFlow is a role-based property-management web application. It includes a Node.js API and browser frontend for developers, administrators, owners, tenants, and agents.

Before continuing development, read [the final product design](docs/FINAL_SYSTEM_DESIGN.md). It defines the agreed four-dashboard model, the owner/caretaker permission split, unit-level rent and lease rules, QR-code identity, tenant onboarding, and mobile-web strategy.

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
| Admin | `admin@propertyflow.local` |
| Owner | `owner@propertyflow.local` |
| Tenant | `tenant@propertyflow.local` |
| Primary agent | `agent@propertyflow.local` |
| Backup agent | `backup.agent@propertyflow.local` |

Do not use demo accounts or the local JSON store in production. Local data is written to `data/store.json`; set `PROPERTYFLOW_STORE_FILE` to change the path.

## Implemented workflows

- Role-scoped dashboards, admin seat allocations, property and tenant onboarding, activation links, invitation reissue, and password reset.
- Account holders set their own password from a single-use invitation. Passwords are stored as scrypt hashes, never retrievable in plaintext; signed-in users can change their password, which revokes their sessions.
- Tenant requests, owner assignment, agent work-order updates, move-out tracking, in-app notifications, and payment history.
- Explicit unit records and lease history, generated unit codes, vacancy-aware tenant invitations, owner rent rolls, and effective-dated rent changes with audit entries.
- Owner-generated, printable/downloadable QR labels with hashed random tokens, secure role-checked scans, token replacement, and access audit entries.
- Email through Resend, SMS through Africa's Talking, and M-Pesa STK Push plus callback processing through Safaricom Daraja when configured.
- PostgreSQL-backed durable storage and a Render service blueprint.

Provider credentials are optional in local development. Without them, the related delivery or payment action reports that it is unavailable; this does not verify provider connectivity. See `.env.example` for the supported environment variables. Never commit `.env` or paste credentials into source code.

## PostgreSQL

Set `DATABASE_URL` to a PostgreSQL connection string. The service applies `database/migrations/001_propertyflow_state.sql` at startup. The current migration stores application data in a single JSONB state row and serializes database-backed API operations with a row lock. Unit and lease collections are stored in that state, with legacy tenant records migrated at load time. This is a simple durable MVP strategy, not a normalized or high-throughput production data model.

When running in production, the server requires `DATABASE_URL`, an HTTPS `APP_BASE_URL`, `SESSION_SECRET` (at least 32 characters), bootstrap developer name/email/password (at least 16 characters for the password), and the Resend, Africa's Talking, and Daraja configuration keys listed in `.env.example`. The first run of a fresh production database creates only the private developer account; production does not seed demo users. Keep database backups and securely store all provider secrets.

## Provider setup

- **Resend:** verify the sending domain and set `RESEND_API_KEY` and `EMAIL_FROM`.
- **Africa's Talking:** configure `AFRICASTALKING_USERNAME`, `AFRICASTALKING_API_KEY`, and, if enabled for the account, `AFRICASTALKING_SENDER_ID`.
- **Daraja:** configure the consumer key/secret, shortcode, passkey, and a high-entropy `DARAJA_CALLBACK_TOKEN`. The callback URL is generated from `APP_BASE_URL`. Keep `DARAJA_ENVIRONMENT=sandbox` until sandbox payments and callback delivery have been verified. Live transactions require Safaricom credentials and approval.

Production credentials, verified email/SMS delivery, public callback reachability, and real payment settlement have not been tested in this repository environment. Do not enable live payments until these have been independently tested.

## Deployment

`render.yaml` describes a Render web service and leaves automatic deployment disabled. Deploy the web service in the same region as its PostgreSQL database so it can use the internal database URL; the current blueprint targets Frankfurt. Set the blueprint's secret values directly in Render, and confirm the public HTTPS URL before the first deployment. Keep M-Pesa in sandbox until the callback and reconciliation behavior are tested. Provider credentials and live deployment still require separate setup and verification.

## Checks

```powershell
npm run check
npm test
```

The API tests exercise local role workflows and production configuration checks. They do not replace browser testing, provider sandbox testing, security review, database recovery testing, or production-readiness review.

The uploaded [final system design](docs/FINAL_SYSTEM_DESIGN.md) remains the product roadmap. Unit inventory, lease records, rent history, rent-roll views, and secure QR labels are implemented. The old delegated-admin/owner role split is intentionally still present; organisation and caretaker permissions, PWA support, and payment reconciliation remain future work.

## API

- `GET /api/health`, `GET /api/config`, `GET /api/dashboard`
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/auth/activate`, `POST /api/auth/password-reset`, `POST /api/auth/password-reset/complete`
- `POST /api/auth/change-password`
- `GET/POST /api/admins`, `POST /api/owners`, `POST /api/agents`
- `POST /api/properties`, `POST /api/properties/:id/units`, `POST /api/units/:id/qr`, `GET /api/units/resolve/:token`
- `POST /api/tenants`, `POST /api/move-outs`
- `PATCH /api/leases/:id/rent` — owner-only effective-dated rent changes
- `POST /api/requests`, `POST /api/requests/:id/assign`, `PATCH /api/work-orders/:id/status`
- `GET /api/payments`, `POST /api/payments/mpesa/stk-push`

Protected API requests use a bearer token returned by login. QR label links lead to sign-in; QR codes do not expose tenant details publicly. Provider callback: `POST /api/payments/mpesa/callback/:token`.
