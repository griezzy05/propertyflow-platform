# PropertyFlow final product design

This document is the source of truth for the next development stage. It records the product decisions made with the product owner before the system is taken live.

## 1. The four dashboards

PropertyFlow must present four clear dashboard experiences. Do not create a separate owner dashboard and a separate general admin dashboard for the same property operation.

| Dashboard | Main user | Purpose |
| --- | --- | --- |
| Developer | Platform owner only | Creates customer accounts, controls subscriptions and capacity, sees service health, and provides audited support. It is never available to customers, tenants, caretakers, or agents. |
| Property Admin | House owner, property manager, or caretaker | Operates one property organisation: properties, units, rents, tenants, vacancies, requests, and agents. |
| Tenant | A current tenant | Sees only their own lease, bills, payments, home details, and submitted requests. |
| Agent | Primary or backup agent | Sees only assigned visits, inspections, and work orders. |

The Property Admin dashboard is one interface with permission levels; it is not two separate products.

- **Owner administrator:** Full access to rents, tenant accounts, payment reports, units, properties, caretakers, and agents.
- **Caretaker:** Uses the same operational interface but cannot change rent, access payout information, delete records, or see full financial reports unless an owner explicitly grants a finance permission.
- **Finance user, if added later:** Can view invoices, receipts, arrears, and reports, but does not need maintenance or building-operation access.

The existing prototype contains a separate owner and delegated-admin workflow. During the next refactor, retain any useful agency workflow but rename and reshape it so that each property organisation has one primary Property Admin account. A caretaker must be a restricted user in that organisation, not an owner of a separate dashboard.

## 2. The property, unit, and rent model

A property is not enough. The system must have a record for every physical rentable unit.

```text
Property: Maple Court
  └─ Unit: B-12
       ├─ Permanent internal ID: unit_8d42f9...
       ├─ Visible unit code: MC-B-12
       ├─ Standard asking rent: KES 30,000
       ├─ Current lease: Brian Otieno, KES 28,000
       └─ QR token: random and non-guessable
```

Create these records separately:

1. **Property** — name, address, owner organisation, building blocks, and general settings.
2. **Unit** — permanent ID, property ID, unit number, unit type, bedroom count, normal asking rent, vacancy state, and QR token.
3. **Lease** — tenant ID, unit ID, agreed rent, deposit, due day, start date, end date, and state such as active, ending, ended, or renewed.
4. **Invoice/payment** — the exact amount due for a period and the payment or balance against it.

The rent must be attached to the active lease, not only to the house. This protects historical records. A unit can have an asking rent of KES 30,000 while an existing tenant completes an older KES 28,000 lease. When the tenant leaves, the new lease can use the new amount without altering old receipts or reports.

Only an owner administrator can change the agreed rent. A rent change must store an effective date and an audit record showing who made the change. Never edit a paid invoice to reflect a later rent increase.

## 3. Automatic unit identity and QR codes

PropertyFlow must generate unit identity automatically. The platform owner does not manually create codes for every apartment.

When a Property Admin adds a unit, the backend creates:

- an immutable internal `unitId`;
- a human-readable code, for example `MC-B-12`;
- a random QR token; and
- a downloadable/printable label linked to that token.

The unit actions let the Property Admin generate or replace a printable PNG label. Only a hash of the QR token is retained; replacing the label invalidates the previous token. Scanning opens sign-in, and the backend checks the signed-in role and unit assignment before returning any unit or work-order information. Authorized scans are audit logged.

The printed code belongs to the physical unit, not its tenant. It remains with the apartment when a tenant moves out. The printed label must not contain tenant names, rent amounts, phone numbers, payment balances, or lease information.

The QR should resolve to a secure link such as:

```text
https://app.propertyflow.co.ke/unit/q7X9mP2kL...
```

After scanning, the backend identifies the unit and then checks who is signed in. An agent can see the assigned job, a tenant can create a request for their own home, and an owner administrator can see the complete unit record. A public scan must never expose private information.

QR labels are optional for launch. The product must still support searching by property and unit code. When labels are used, the owner, caretaker, or agent downloads the printable sheet and places it on the door, meter box, or building file. PropertyFlow may later offer paid printing and delivery, but distribution is normally the customer’s responsibility.

The system must support QR replacement. If a label is damaged, copied, or incorrectly placed, the owner administrator can deactivate the old token and generate a new one while retaining the permanent unit history.

## 4. Tenant onboarding

Tenants do not find the service on their own. They are invited when they move in.

1. Property Admin creates or selects the unit.
2. Property Admin creates the lease and enters the tenant’s name, phone number, email if available, rent, deposit, due date, and lease dates.
3. The system allocates one tenant account from the property organisation’s subscription capacity.
4. The system sends a secure invitation by email, SMS, or WhatsApp.
5. The tenant opens the link, verifies a one-time code or invitation token, sets a password, and reaches their Tenant dashboard.

The invitation must expire, be single-use, and be reissued only by an authorised Property Admin. Tenants should be encouraged to add the web application to their phone home screen.

## 5. Device strategy

Launch PropertyFlow as a responsive web application and Progressive Web App (PWA). It must work in the browser on Android phones, iPhones, tablets, laptops, and desktop computers. A person can use “Add to Home Screen” to get an app-like icon without downloading from an app store.

Do not make Google Play Store or Apple App Store publication a launch requirement. Native apps can be added later after usage proves the need for offline features, push notifications, camera workflow, or a more polished mobile experience.

## 6. Access and subscription capacity

The developer creates the property organisation’s primary Property Admin account. The allocation belongs to that organisation, not personally to a caretaker.

The initial product rule is at least 50 tenant accounts for an organisation created by the developer. The owner administrator uses those accounts to invite tenants. Caretakers and agents do not consume tenant capacity.

Each paid property organisation includes two agent accounts by default: primary and backup. Additional agent accounts may be a paid add-on later.

## 7. Next implementation checklist

- [ ] Replace the owner/delegated-admin split with a Property Admin organisation and caretaker permission model.
- [x] Add unit and lease collections; legacy tenant records receive a best-effort unit/lease migration when loaded.
- [x] Add a unit creation form with asking rent, unit type, and generated unit code.
- [x] Add QR-token creation, secure role-checked resolution, printable label download, token rotation, and scan audit logs.
- [x] Add a unit rent roll showing unit, tenant, agreed rent, due date, paid amount, and balance.
- [x] Add an owner-only rent-change workflow with an effective date and audit history.
- [ ] Add restricted caretaker permissions and test that caretaker accounts cannot access finance routes.
- [ ] Add tenant invitations via the configured email/SMS provider and, later, WhatsApp if adopted.
- [ ] Implement PWA manifest, icons, service worker, and Add-to-Home-Screen guidance.
- [ ] Keep M-Pesa in sandbox until payment callbacks, reconciliation, receipts, and failed-payment cases are tested.
