# BZEAD Buyer Storefront Documentation

Last reviewed: 2026-10-21

This document describes the application in this repository as implemented in
the source, configuration, and database migrations. It covers the BZEAD.MV and
BZEAD.IN buyer builds, their shared Supabase backend, and the intended
relationship to BZEAD.COM and BZEAD.ASIA. Local configuration is not proof that
a domain or deployment is live.

## 1. Product and domain context

### BZEAD.COM

BZEAD.COM is the parent/global marketplace identity referenced by this
application. The repository's About page describes BZEAD as a buyer-and-seller
marketplace focused on Asia and the United Kingdom. The main site also hosts
the seller portal: links in this buyer application take sellers to
`https://www.bzead.com/seller`.

The Maldives storefront does not replace BZEAD.COM or create a separate seller
catalog. Its product, seller, account, and order data is designed to use the
existing shared Supabase marketplace backend. This lets the buyer experience
be localized while sellers and marketplace operations remain part of the
existing platform.

### BZEAD.MV

BZEAD.MV is the Maldives-focused, buyer-only storefront built by this
repository. It is compiled with the market code `MV`, presents prices in
Maldivian rufiyaa (MVR), and constrains the buyer shipping flow to Maldives.
The implementation is market-gated so that Maldives-specific behavior is
separated from the global-market behavior in shared UI and services.

The repository configures AWS Amplify to build and host the static buyer
frontend. Supabase remains the application backend; Amplify is not a replacement
for Supabase.

### BZEAD.IN

BZEAD.IN is the India-focused, buyer-only build. It uses `VITE_MARKET=IN`, fixes
display and checkout currency to INR, and restricts checkout shipping addresses
to India. Its public origin is `https://www.bzead.in`; its build output is
`dist-buyer-in`. It uses the existing shared Supabase marketplace backend and
does not create a separate catalog, seller system, or database.

### BZEAD.ASIA: intended role and current implementation status

The regional rationale for BZEAD.ASIA is to provide an Asia-oriented brand and
entry point for BZEAD's regional marketplace work: a clear regional identity
for customers and partners, with room for country-specific storefronts,
currencies, pricing, delivery rules, and customer communications. A regional
brand can make localized buyer experiences easier to understand without
turning each country storefront into an unrelated marketplace or duplicating
the shared seller/catalog backend.

In that model:

- **BZEAD.COM** remains the parent/global marketplace and seller-portal
  destination.
- **BZEAD.ASIA** is the planned regional brand/entry point for Asian markets.
- **BZEAD.MV** is the Maldives-specific buyer experience.
- Country storefronts can share marketplace infrastructure while applying
  country-scoped pricing and commerce rules.

Important: this repository does not contain a dedicated BZEAD.ASIA market
build or deployment specification. A few Edge Function CORS lists mention
BZEAD.ASIA, but that alone does not establish a working storefront, DNS
mapping, or production deployment.

## 2. What this application does

This is a React single-page buyer storefront for product discovery and
purchase. Its current user-facing areas include:

- Home page with featured, sponsored, deal, and trending product content.
- Category and section listings, product search, product detail pages, and
  shareable product URLs.
- Buyer signup, login, OTP/password recovery, profile, saved addresses,
  wishlist, cart, notifications, order history, reviews, and returns.
- Checkout shipping, order review, and payment steps, with market-aware
  pricing, delivery eligibility, and currency handling.
- Legal, policy, About, and Contact pages.
- Responsive web UI and Capacitor-oriented mobile runtime helpers.

This is a **buyer app**, not the seller or administrator application. Seller
and administrator roles are not given seller/admin dashboards in this
storefront. Seller links redirect to the seller portal on BZEAD.COM.

## 3. Technology and runtime architecture

### Frontend

- React 19 with TypeScript.
- Vite 7 for development and production builds.
- React Router for client-side routing and lazy-loaded page chunks.
- Tailwind CSS for utility styling.
- Lucide React and React Icons for iconography.
- Vitest, jsdom, and Testing Library for tests.
- Capacitor 8 packages and `src/mobile/` runtime integrations for supported
  native-webview behaviors.

### Backend and external services

- Supabase JavaScript client for authentication, PostgREST/database access,
  storage, realtime-capable auth/session behavior, RPCs, and Edge Functions.
- Supabase SQL migrations define database changes and RPCs.
- Supabase Edge Functions handle privileged or provider-facing operations.
- Stripe.js and Stripe Payment Element are used for online payment flows.
- Shiprocket and Shippo services are represented in the checkout/shipping
  code and Supabase Edge Functions.
- OneSignal is used for push-notification integration.
- Exchange rates are fetched through the exchange-rate service and Supabase
  functions; secret API keys belong on the server.
- Optional Google AdSense slots can be enabled using public build variables.

### High-level request flow

```text
Buyer browser / supported Capacitor webview
        |
        +-- React storefront (AWS Amplify static hosting)
        |
        +-- Supabase public client
              +-- Auth and profile data
              +-- Catalog, variants, categories, cart, wishlist, and orders
              +-- Market-price / checkout RPCs
              +-- Storage
              +-- Edge Functions
                    +-- Stripe, shipping, email, FX, push, and share-image tasks
```

The frontend uses a public Supabase client key. Authorization and row access
must be enforced by Supabase policies and trusted functions; public frontend
configuration is not a substitute for backend authorization.

## 4. Market and pricing behavior

### Market selection

`src/config/market.ts` defines the MV and IN country/currency settings. The MV
build sets `VITE_MARKET=MV` and fixes the buyer market to Maldives/MVR. The IN
build sets `VITE_MARKET=IN` and fixes the buyer market to India/INR. Both builds
hide location and manual currency switching and use distinct browser cache and
checkout-draft namespaces. Other market values retain the global behavior.

### Catalog prices

Displayed catalog prices are obtained from the existing public-price RPCs in
`src/lib/pricingService.ts`, not assumed to be the seller's raw base price.
The country passed to the price service determines the applicable public
market price/markup rule. BZEAD.COM's shared pricing system remains the
source of market pricing; this repository does not introduce an independent
pricing engine.

The home page caches product content and market-specific prices separately in
browser local storage. Cache keys include the market and destination country.
Prices are cached per product, allowing reusable entries when the home product
list changes. Cached values are time-bounded; newly fetched values are merged
without discarding other still-valid product prices.

### Variants and checkout

When a cart line has a selected variant, checkout verifies that selection
against live `product_variants` rows using the variant ID, SKU, size, and/or
color. It uses the selected variant's price as the pricing input and rejects a
missing, changed, ambiguous, or unpriced selection. A selected variant must
not silently become the parent product's price.

Checkout pricing also calculates applicable market price, conversion,
discount/offer, shipping, and eligibility data. The MV and IN builds require
valid target-currency conversions and block checkout when required pricing or
shipping amounts cannot be verified. Buyer addresses are constrained to the
build's country; the IN flow validates six-digit Indian PIN codes.

Cash on Delivery is disabled by the shared checkout pricing logic. Stripe is
integrated for online payments, but payment-provider support and enabled
payment methods are deployment/provider configuration concerns; verify live
provider and currency support before enabling order-taking in any market.

### Currency and rates

The MV build fixes the display target to MVR; the IN build fixes it to INR.
Neither allows a buyer's saved or manually selected currency to override the
storefront currency. `CurrencyContext` converts source amounts using
exchange-rate data. If a required conversion is unavailable, the UI/checkout
must surface an unavailable state or block the transaction instead of
presenting a source amount as if it were the target currency.

## 5. Search

The search box provides debounced autocomplete, recent-search history, keyboard
navigation, and full results.

- `search_products_fts` is the existing full-text/trigram search function.
- `search_products_catalog` is an additive paginated catalog search function
  introduced in migration `20261020153000`. It prioritizes exact IDs/SKUs,
  name and brand matches, and relevant category/variant/typo matches.
- The full-results client hydrates complete product records while preserving
  RPC relevance order, and exposes a load-more action.
- Autocomplete protects against stale responses and uses a bounded, expiring
  in-memory cache.
- Search-result price sorting/filtering uses the public market price converted
  into the storefront display currency; it does not use seller base price as a
  substitute.

The search migration was applied directly to the linked Supabase project during
implementation. It is additive and leaves the existing shared search function
unchanged. Review migration status before future deployment; do not use a
general migration push without checking for unrelated pending migrations.

## 6. Routes and access

Routes are declared in `src/App.tsx`; page components are in `src/pages/`.
There is no separate route-folder hierarchy.

| Route pattern | Purpose | Access |
|---|---|---|
| `/` | Storefront home | Public |
| `/products/section/:section` | Featured, hot-deals, trending, and query results | Public |
| `/products/featured`, `/products/hot-deals` | Legacy redirects to section routes | Public |
| `/products/:productId` | Product detail | Public |
| `/products/:productId/review` | Write a product review | Signed-in buyer |
| `/share/:slug` | Client fallback to product detail; social preview HTML is generated at build time | Public |
| `/category/:categoryId` | Category product listing | Public |
| `/login`, `/signup` | Buyer authentication | Public |
| `/otp-verification`, `/forgot-password`, `/new-password` | Authentication and recovery flows | Public auth flow |
| `/cart`, `/wishlist`, `/orders`, `/orders/:orderId` | Buyer shopping and order areas | Signed-in buyer |
| `/checkout/shipping`, `/checkout/review`, `/checkout/payment`, `/checkout/confirmation` | Checkout journey | Signed-in buyer |
| `/profile`, `/settings`, `/notifications`, `/user/addresses` | Buyer account management | Signed-in buyer |
| `/privacy-policy`, `/terms-of-service`, `/shipping-policy`, `/refund-policy`, `/terms-and-conditions`, `/about`, `/contact` | Informational and legal pages | Public |
| `/seller`, `/seller/*` | External seller-portal redirect | Redirects to BZEAD.COM |

The route guard permits public catalog and content routes, allows buyer routes
for buyer accounts, and redirects signed-out users from protected buyer routes
to login. Admin and seller accounts are redirected away from buyer-only pages.

## 7. Main source areas

| Path | Responsibility |
|---|---|
| `src/App.tsx` | Providers, routing, access guard, lazy loading, and app shell |
| `src/pages/` | Public storefront and buyer account/checkout pages |
| `src/components/layout/` | Header, footer, navigation, search, banners, and shared layout |
| `src/components/products/` | Product cards, variant selection, quick view, and images |
| `src/components/auth/` | Buyer login/signup UI |
| `src/contexts/` | Authentication, cart, wishlist, and currency state |
| `src/hooks/` | Reusable delivery, cart, wishlist, push, and UI logic |
| `src/lib/` | Supabase services for products, prices, checkout, orders, shipping, and notifications |
| `src/utils/` | Currency, logging, formatting, validation, invoice, and environment helpers |
| `src/config/` | Market, base URL, and product-variant display configuration |
| `src/mobile/` | Capacitor detection, external links, native bootstrap, push, and native lifecycle behavior |
| `src/types/` | Shared TypeScript models |
| `src/__tests__/` | Unit and focused regression tests |
| `scripts/` | Build-time share-page and bulk-template utilities |
| `supabase/migrations/` | Versioned database schema, policies, indexes, and RPC changes |
| `supabase/functions/` | Supabase Edge Function source |
| `public/` | Static public assets and web-app association/worker assets |

## 8. Supabase capabilities used by this application

The repository currently contains a large migration history and these Edge
Function directories:

- `create-payment-intent`, `stripe-webhook`, and `refund-payment` — Stripe
  payment lifecycle.
- `shiprocket-rate`, `shiprocket-ops`, and `intl-tracking-webhook` — Shiprocket
  rating, shipment operations, and tracking updates.
- `shippo-rate`, `shippo-ops`, and `shippo-webhook` — Shippo rates, shipment
  operations, and webhooks.
- `exchange-rates` and `sync-exchange-rates` — currency-rate retrieval and
  synchronization.
- `send-email`, `send-contact-email`, `pickup-otp` — email/contact and pickup
  verification flows.
- `send-push-notification`, `register-push-token`, and `test-push` — push
  notification operations.
- `reverse-geocode` — location lookup support.
- `product-og` and `product-og-image` — product sharing metadata/image support.

The functions present in the repository are not proof that every function is
currently deployed, configured, or enabled in production. Check the linked
Supabase project and its secrets/provider credentials before relying on one.
Never place service-role keys, payment secrets, shipping credentials, email
credentials, or OneSignal REST credentials in frontend build variables.

## 9. Environment variables and secrets

The `.env.example` file is the canonical template. The Vite build guard
requires:

- `VITE_SUPABASE_URL`
- One public Supabase key, supplied as `SUPABASE_PUBLISHABLE_KEY`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`, or the legacy
  `VITE_SUPABASE_ANON_KEY`.
- `VITE_PUBLIC_APP_URL` for market production builds, used for canonical,
  share, and authentication URLs. Use `https://www.bzead.in` for the IN build.

Other frontend configuration can include:

- `VITE_MARKET=MV` or `VITE_MARKET=IN` — market selector; the build scripts set
  this for the corresponding buyer build.
- `VITE_STRIPE_PUBLISHABLE_KEY` — public Stripe.js key.
- `VITE_ONESIGNAL_APP_ID` — public OneSignal application ID.
- `VITE_ADSENSE_CLIENT` and `VITE_ADSENSE_SLOT_HOME_FOOTER` — optional ad setup.
- `VITE_DOMAIN` — legacy/alternate public URL input used by URL helpers.

Secrets such as Stripe secret keys, Supabase service-role/access tokens,
Shiprocket/Shippo credentials, email provider keys, exchange-rate API keys,
and OneSignal REST keys belong in trusted server-side configuration (normally
Supabase secrets), never in `VITE_*` variables. Do not commit real `.env`
files.

## 10. Local development, build, and tests

Install the lockfile dependencies and configure the required public variables
using a local ignored `.env` file:

```bash
npm ci
npm run dev
# `npm run dev` starts the India storefront; use `npm run dev:maldives` for MV.
```

Useful project commands:

```bash
npm run build              # India production build
npm run build:buyer        # India buyer build alias
npm run build:buyer:india   # type-check, IN Vite build, and India share pages
npm run build:buyer:maldives # type-check, MV Vite build, and Maldives share pages
npm run build:india         # alias for build:buyer:india
npm run build:maldives      # alias for build:buyer:maldives
npm run build:share-pages  # share page generator
npm run lint               # ESLint
npm test                   # Vitest suite
npm run test:watch         # Vitest watch mode
npm run test:coverage      # Vitest with coverage
```

The default buyer build uses `VITE_MARKET=IN` and writes to `dist-buyer-in`.
The Maldives build uses `VITE_MARKET=MV` and writes to `dist-buyer`; generated
output is ignored by Git.
Local production builds need the same required public configuration as the
deployed build. AWS Amplify variables are available to Amplify builds but are
not automatically present in a developer's local shell.

## 11. AWS Amplify deployment

`amplify.yml` builds the IN storefront. `amplify.maldives.yml` builds the MV
storefront. Each build spec:

1. Runs `npm ci`.
2. Runs its market-specific buyer build command.
3. Publishes its market-specific output directory.
4. Configures security headers and long-lived caching for versioned assets.

Configure the India Amplify app/branch to use `amplify.yml` and set its public
origin to `https://www.bzead.in`, plus the shared Supabase URL/public key and
any intentionally enabled provider keys. Configure the Maldives app to use
`amplify.maldives.yml` and its MV origin.
Amplify's SPA rewrite must send application routes to `index.html`, while
allowing generated `/share/*` HTML to be served directly. Confirm this rewrite
in the Amplify console for the deployed app.

The repository does not contain authoritative DNS records or proof that either
custom domain is connected to Amplify. Domain mapping, DNS, TLS, SPA rewrites,
and deployed environment variables must be verified in AWS and the DNS
provider. The shared Supabase project must also be updated with the IN auth
redirect URL and deployed Edge Function origin changes from the repository.

## 12. Build-time share pages and caching

`scripts/generate-share-pages.mjs` creates static share-preview HTML from
Supabase product records for social crawlers, with product title, description,
image, canonical URL, and a redirect to the client-side product page. In the
buyer build, it deliberately omits raw seller price/currency metadata so
unconverted catalog values are not represented as buyer-facing market prices.
Product images can use the Supabase `product-og-image` function.

Homepage sections, banners, and prices use localStorage caches with separate
market/country namespaces and bounded freshness. Browser storage is a
performance optimization, not the system of record; the backend remains
authoritative for inventory, public price, variant, shipping, and checkout
validation.

## 13. Tests and quality checks

Tests live under `src/__tests__/` and run with Vitest. They cover core
currency/checkout-related services, search, product variants, caching,
shipping, validation, and payment integration behavior. Use focused test files
for a targeted change, then expand validation when the affected surface
requires it.

Current source includes dedicated search tests in
`src/__tests__/productSearchService.test.ts`; the search change was type-checked
and tested. A full deployed Amplify build still needs to run in the Amplify
environment with its configured variables.

## 14. Security and operational boundaries

- Treat all `VITE_*` values and the publishable Supabase key as public; they
  are embedded in browser assets.
- Keep authorization, row-level access, payment verification, webhook
  verification, and privileged mutations on trusted backend paths.
- Never accept a client total as authoritative for order creation; revalidate
  selected variant, price, shipping, eligibility, and payment on trusted
  server-side paths.
- Do not silently substitute another market's price, a parent product price
  for a selected variant, or a source-currency number for an unavailable MVR
  conversion.
- Do not deploy every local migration blindly to the shared Supabase project.
  Check local/remote migration status and apply the intended migration only;
  unrelated pending changes can affect the main BZEAD.COM backend.
- Do not assume Edge Function source equals deployed function state. Verify
  deployment status, secrets, provider accounts, and webhook configuration.
- Check error reporting and logs for failed payment, pricing, rate, shipment,
  and notification operations.

## 15. Known limits and items that need separate verification

- BZEAD.ASIA has no implementation or deployment configuration in this
  repository; this document records its intended regional role only.
- Live DNS/domain ownership, Amplify rewrite configuration, and active
  production build variables are external to the repository.
- Database migrations and Edge Function files do not establish that every
  corresponding production object is deployed or healthy.
- Payment methods/currency support and shipping-provider availability depend
  on the connected production accounts and configuration; validate these
  before announcing a market as ready for orders.
- Business/legal copy on the About and policy pages should be reviewed by the
  company before being treated as authoritative legal or corporate advice.
- Keep this document updated when routes, market support, pricing, payment,
  shipping, domains, providers, or deployment configuration change.
