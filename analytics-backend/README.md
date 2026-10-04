# Private visitor analytics

The portfolio stays on GitHub Pages. A separate Cloudflare Worker receives automatic visit records, stores them in D1, and serves a private dashboard at `/admin`.

## Current state

The production endpoint in `assets/analytics-config.js` records normal visits automatically. GitHub Pages continues to host the portfolio; Cloudflare hosts the collector, database and dashboard. An empty endpoint disables frontend collection.

## Local development

Requires Node.js 22+ and pnpm 10.26+ (or npm to install the dependencies).

```powershell
cd C:\Users\InamiLab_Kong\Desktop\nero-Kong.github.io\analytics-backend
pnpm install
node scripts/build-icons.mjs
node scripts/prepare-local.mjs
node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local
node node_modules/wrangler/bin/wrangler.js dev --port 8788
```

Open `http://localhost:8788/admin`. The randomly generated **local** key is in `.dev.vars`. It is ignored by Git and is not a production credential. Local IP and location metadata is not representative of real visitors.

## Production deployment

1. Register your own account at https://dash.cloudflare.com/sign-up.
2. In `analytics-backend`, run `node node_modules/wrangler/bin/wrangler.js login` and authorize in the browser. No Cloudflare password belongs in this repository.
3. Run `node scripts/deploy.mjs`. It reuses or creates the named D1 database, applies migrations, builds Lucide icons, deploys the Worker and verifies `/health` before updating the frontend configuration.
4. The dashboard address is in ignored `.admin-access.json`. In Cloudflare Access mode, sign in with the allowed Cloudflare account; no local key file is required. Bearer mode instead uses a separate random production key deployed as a secret, never frontend code.
5. Review and push the website changes to GitHub Pages. The deployment helper intentionally does not commit or push.

If your Cloudflare account has multiple organizations, select the intended `CLOUDFLARE_ACCOUNT_ID` before deployment. This implementation does not require buying a domain or moving the portfolio away from GitHub Pages. Review Cloudflare's current Workers and D1 usage limits in your account; provider quotas still apply.

## Cloudflare account login

Enable Zero Trust Free and connect the Cloudflare identity provider with account-member restriction enabled. Create one self-hosted Access application with public destinations matching the Worker hostname's `/admin`, `/api/*` and `/index.html` paths. Only select the Cloudflare identity provider. Add an Allow policy including only the owner's exact email; never use Everyone or an entire email domain. Set a 24-hour session and HttpOnly cookies. Do not protect the entire Worker or `/collect` and `/health`.

After saving and checking the application, copy its audience tag and configure the backend:

```powershell
node scripts/configure-access.mjs <team-name> <application-audience> <owner-email>
node scripts/deploy.mjs
```

The owner email is saved only in ignored `.production.vars` and deployed as `ACCESS_ALLOWED_EMAIL`. `AUTH_MODE`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are non-secret deployment settings. Local `.dev.vars` explicitly retains `AUTH_MODE=bearer`. Production Access mode validates the JWT signature against Cloudflare's rotating public keys, issuer, audience, expiry and owner email; neither the old bearer key nor an email header alone grants access. Incomplete configuration fails closed. The Worker also checks tokens on alternate HTML and API entry points.

The dashboard uses same-origin session cookies and loads after sign-in without another key prompt. Expired sessions require sign-in again. Sign out uses Cloudflare's `/cdn-cgi/access/logout` endpoint and may end sessions in other Access applications, not the Cloudflare dashboard account. Cookie-authenticated deletion additionally requires the exact same-origin header and explicit confirmation.

## Data and controls

- Full public IP, server timestamp, page path, approximate country/region/city, network ASN and organization, and referrer hostname. No URL queries/fragments, raw user-agent, persistent visitor IDs or precise geolocation.
- Normal visits are recorded automatically without an opt-in dialog, public privacy page or on-site preference control. The tracker does not read previously stored visitor preferences, and neither the tracker nor the collection endpoint uses Do Not Track or Global Privacy Control as a collection gate. Only the official HTTPS portfolio hostname sends records; local previews are not counted.
- IPs and geography come from Cloudflare request metadata, not the request body's claims. Known bot user-agents are skipped, but this is not a comprehensive bot classifier. Origin checks and request limits deter accidental/low-effort misuse; Origin can be spoofed outside browsers, so this is not an audit-grade attendance log.
- Records have no automatic expiry. No scheduled cleanup is deployed, and queries do not discard older records. Records stay in the database until manually deleted or the service is removed, subject to provider storage limits and availability. Cloudflare-managed backups have separate retention policies.
- Production dashboard authentication uses Cloudflare Access in account-login mode; local development uses a random 256-bit bearer key held only in page memory. No credentials are written to frontend code or local storage. Production HTTP requests redirect to HTTPS; localhost previews remain available over HTTP. CSP, no-store and frame protections apply to dashboard and API responses.
- The dashboard supports Japan-time custom date filters and All dates, page/country/IP/network/city filters, pagination, optional full IP display, CSV export (up to 10,000 matching records, with spreadsheet formula escaping), and confirmed deletion of filtered records.
- Counts are page views and distinct IPs, not distinct people. Shared networks and VPNs affect interpretation. External MoHeat pages cannot be tracked by this site's script.
- `EXCLUDED_IPS` is an optional comma-separated Cloudflare secret for excluding your own public IP addresses. Proxy/VPN locations are approximate; never use IP data to assert a visitor's personal identity.
- Automatic collection, indefinite retention and removal of the public notice are technical settings, not a legal compliance assessment. Review applicable privacy requirements and a justified retention policy before enabling the service for real visitors.

## Verification

```powershell
node --test test/*.test.mjs
node node_modules/wrangler/bin/wrangler.js deploy --dry-run
```

The automated API tests use an in-memory SQLite database and synthetic documentation IPs, not real visitor logs. Test screenshots and local databases are ignored by Git. `.dev.vars`, `.production.vars`, `.admin-access.json`, `.wrangler`, and `node_modules` must remain excluded from commits. `_config.yml` excludes the backend project from the GitHub Pages build.

To stop future collection, empty the frontend endpoint and publish it; also remove/disable the Worker if stopping all service requests is required. Rotate the production secret if its key is exposed.
