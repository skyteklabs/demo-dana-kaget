# Dana Kaget

Enter an email, pass Cloudflare Turnstile, receive a six-digit verification code, and press **Claim** to reveal a DANA reward. Set a shared link in `DANA_REWARD_LINK`, or leave it blank to use individually allocated inventory. Each normalized email has one recorded claim; retries and later verification return its original reward. Links appear as a QR code with a clickable URL below.

## Run locally

Docker Compose includes the app and a Mailpit test inbox. If `.env` exists, apply the local settings listed at the bottom of `.env.example` before running this recipe (`APP_MODE=local`, the localhost origin and test Turnstile keys). Compose defaults to local mode only when `APP_MODE` is unset or empty:

```sh
docker compose up -d --build
docker compose exec app npm run import:codes -- --demo
```

- Form: http://localhost:4173/dana-kaget (also `/`; old `/bpu` links still work).
- Test inbox: http://localhost:8025 — local email stays here and is not delivered externally.
- Analytics: http://localhost:4173/analytics.
- Health: http://localhost:4173/healthz.

Local mode uses Cloudflare's official success test keys by default. Internet access is needed for the widget and server verification. Demo rewards start with `DEMO-NOT-REDEEMABLE-` and cannot be redeemed in DANA. Leave `DANA_REWARD_LINK` blank for this demo-inventory recipe; inventory starts empty until imported.

The supported Node runtime is **22.23.2 or newer within 22.x**. The Dockerfile pins Node `22.23.3-alpine` by image digest, and local Compose pins Mailpit `v1.31.4` by digest. Node 22 marks its built-in SQLite API experimental.

To run Node directly, copy the live `.env.example` template and apply the local settings at the bottom of that file (`APP_MODE=local`, the localhost origin and test Turnstile keys) before starting:

```sh
docker compose up -d mailpit
cp .env.example .env.local
# Edit .env.local to apply the local settings before continuing.
npm run import:codes -- --demo
npm start
```

Node reads `.env`, then optional `.env.local` overrides; Compose reads `.env` or a file specified with `docker compose --env-file .env.local ...`. Existing shell variables take precedence. Node and Compose use different data directories unless explicitly configured to share one.

## Deploy behind Traefik

Use `docker-compose.traefik.yml` as a standalone file on the host running your existing Traefik Docker provider. It joins the external `edge` network, listens internally on port 4173, and routes HTTPS through the `websecure` entrypoint. It builds this app from the local Dockerfile and persists claims and events in the `dana-kaget_analytics-data` volume. The local Compose stack uses a different project and volume by default.

Copy `.env.example` to your private `.env` if needed and fill the live Turnstile and Kirim.Email credentials plus a stable `CLAIM_SECRET`. The configured hostname is `APP_HOST=dana.skytek.id`, without a scheme, port, or path. Point its DNS to Traefik and allow the same hostname on the Turnstile widget. This Compose file always uses live mode and derives `PUBLIC_ORIGIN=https://APP_HOST`; its origin overrides the value in `.env`.

Set `TRUSTED_PROXY_CIDRS` to Traefik's actual address on `edge`; this is required by the Traefik Compose file. Use `docker network inspect edge` to find the address, then prefer its exact IPv4 `/32` or IPv6 `/128`. Keep that address stable or update the setting when it changes. Comma-separated entries support more than one trusted proxy. Do not trust an entire shared `edge` subnet containing other services, and do not enable Traefik's `forwardedHeaders.insecure` option. If another proxy sits in front of Traefik, explicitly configure its trusted addresses in Traefik too.

Traefik must already be attached to `edge` with `websecure` and a certificate for the chosen hostname. The labels use your existing TLS setup; no certificate resolver name is assumed. If your Traefik requires a per-router resolver, add `traefik.http.routers.dana-kaget.tls.certresolver` with that resolver's name. Routing label details are in the [Traefik Docker documentation](https://doc.traefik.io/traefik/reference/routing-configuration/other-providers/docker/).

```sh
docker compose -f docker-compose.traefik.yml config --quiet
docker compose -f docker-compose.traefik.yml up -d --build
docker compose -f docker-compose.traefik.yml ps
```

After deployment, the public form is at `https://dana.skytek.id/dana-kaget`; `/healthz` reports app health. The stack has no published host port or Mailpit service. Use this file alone, rather than merging it with `docker-compose.yml`, which would bring back the local ports and Mailpit dependency.

The router forwards requests for the configured hostname to the app, which enforces report access itself. In live mode, `/analytics`, `/analytics/`, `/report.html`, `/api/report`, and `/api/events/export` return 404 unless both `REPORTS_USER` and `REPORTS_PASSWORD` are configured. To enable operator reports, set a username and a random password of at least 32 characters, then recreate the app. A browser visiting `/analytics` receives an HTTP Basic authentication prompt; the report APIs require the same credentials. TLS is required. The form displays its report navigation only when reports are enabled. `/analytics/*.js` remain accessible because the form imports those scripts.

Forwarded addresses are used only when the direct peer matches `TRUSTED_PROXY_CIDRS`. The app walks `X-Forwarded-For` from right to left and selects the first untrusted address for rate limits. Empty proxy configuration trusts no forwarded headers and is appropriate for direct/local access. An incorrect proxy address causes visitors behind that proxy to share its rate limits; an overly broad trusted range can allow spoofed client addresses.

Both Compose app services run without root privileges, with a read-only root filesystem, all Linux capabilities dropped, privilege escalation disabled, and a bounded temporary filesystem. Only the data volume and temporary directory are writable. These files prepare deployment; the repository audit does not establish that the production stack has been deployed or validated.

## Configure the shared DANA link

Fill the blank `DANA_REWARD_LINK` setting in your private `.env` with the actual DANA link. The example below shows the format only; replace the token before starting:

```dotenv
DANA_REWARD_LINK='https://link.dana.id/kaget?c=<your-link-token>'
```

Only HTTPS URLs on `dana.id` or `link.dana.id` with a non-empty path are accepted, up to 2048 characters. Literal placeholders are rejected. The link stays on the server until a successful, cookie-bound OTP claim; it is absent from public configuration, verification emails and analytics. Both Compose files pass this setting to the app.

To deploy this feature and apply the setting:

```sh
docker compose -f docker-compose.traefik.yml up -d --build --force-recreate app
```

Every new verified email receives the same configured link, with one persistent claim per normalized email. No inventory import is needed in shared mode. Retrying or verifying that email again recovers its original claim without creating another. Changing the setting affects only new claimants; earlier claimants keep their original reward, including any individually allocated reward from before shared mode was enabled. Clearing the setting returns new claimants to imported inventory; existing claims remain recoverable. Preserve the data volume and `CLAIM_SECRET` to retain these limits.

This app records one claim per email, not per person or DANA account. A revealed shared link can be copied or forwarded. DANA determines the link's remaining balance, expiration and per-account redemption limits; the app cannot enforce those limits or confirm redemption.

The browser generates the QR locally with the bundled encoder; no reward link is sent to an external QR service. The clickable URL below opens DANA in a new tab and can also be copied. Very long links that would produce an overly dense QR keep the clickable/copyable URL with a fallback message. Plain legacy/demo codes still display as text. The link control uses native keyboard activation and has no outbound `href` for automatic click analytics to collect.

## Import your private list

Use this alternative when `DANA_REWARD_LINK` is blank. Supply a UTF-8 text file with **one plain code or HTTPS link per line**, or a JSON array of strings. Your `https://dana.id/<random_code>` format is supported, as is `https://link.dana.id/...`. Replace the placeholder with each existing code from your list; the app does not invent DANA codes. Each imported link is preserved and revealed as a QR and clickable link. Other link domains/schemes, literal placeholders, blank entries in JSON, embedded whitespace, and malformed entries are rejected. Duplicate values are skipped, including already allocated values. The entire file is validated before writing.

For Node:

```sh
npm run import:codes -- /absolute/private/path/dana-codes.txt
```

For the running Compose app, stream the file into the import command:

```sh
docker compose exec -T app npm run import:codes -- - < /absolute/private/path/dana-codes.txt
```

For Traefik, add `-f docker-compose.traefik.yml` immediately after `docker compose`.

Only counts are printed. Keep the source file outside the repository and `public/`; never add it to the image. The app imports entries into private SQLite storage; it does not reread or delete the original file. No real inventory file has been supplied with this project.

The named `analytics-data` volume persists both events and claim state; `mailpit-data` persists local messages. `docker compose down` retains these volumes. Do not remove the volumes if you need to preserve allocation history.

## Live email and CAPTCHA

The example file defaults to `APP_MODE=live`. Copy it to your private environment file, fill the credentials, and replace the HTTPS origin before starting. Configure the production Turnstile widget for that origin's hostname and use both keys from that widget. Live mode controls both Kirim.Email delivery and Turnstile verification; it rejects the local test keys.

| Variable | Purpose |
| --- | --- |
| `APP_MODE=live` | Uses Kirim.Email; refuses missing credentials and Cloudflare test keys. |
| `PUBLIC_ORIGIN=https://your-host.example` | Exact public origin, without trailing slash; also checks Turnstile hostname. |
| `TURNSTILE_SITE_KEY` | Public widget key configured for that hostname. |
| `TURNSTILE_SECRET_KEY` | Server-only Siteverify secret. |
| `KIRIM_EMAIL_DOMAIN` | Kirim.Email sending domain, e.g. `skytek.id`; sent in the `domain` header. |
| `KIRIM_EMAIL_USERNAME` | Server-only Basic auth username from the Kirim.Email API example. |
| `KIRIM_EMAIL_PASSWORD` | Server-only Basic auth password from the Kirim.Email API example. |
| `EMAIL_FROM` | Sender address on your Kirim.Email domain, e.g. `claim@skytek.id`. Replace with your actual sender. |
| `CLAIM_SECRET` | Stable random secret of at least 32 characters for HMAC hashing. Keep with database backups. |
| `DANA_REWARD_LINK` | Private shared HTTPS DANA link, revealed after verification; one recorded claim per email. Blank uses imported inventory. |
| `TRUSTED_PROXY_CIDRS` | Comma-separated trusted proxy addresses/CIDRs; required for Traefik, empty for direct/local access. Prefer Traefik's exact `/32` or `/128`. |
| `REPORTS_USER`, `REPORTS_PASSWORD` | Optional HTTP Basic credentials for reports; live reports stay disabled unless both are set. Password must be 32–1024 characters. |
| `GA4_MEASUREMENT_ID`, `GROVS_API_KEY` | Optional public analytics SDK identifiers. |
| `ANALYTICS_DEBUG=false` | Hides the form's local event inspector. |

Local and live modes use separate databases (`dana-local.sqlite` and `dana-live.sqlite`). Import the real inventory while the application is configured in the intended mode. A local key is generated privately when no `CLAIM_SECRET` is configured. Changing this secret makes existing email/challenge hashes unusable: preserve it with the database.

Turnstile tokens are verified on the server. Live requests must match the hostname and `request_code` action; no browser-only success is trusted. Cloudflare tokens are single-use and expire after five minutes. Every new email request requires a fresh token. See [Cloudflare hostname settings](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/), [server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), and [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

The live adapter follows the supplied Kirim.Email v4 example: `POST https://smtp-app.kirim.email/api/v4/transactional/message`, Basic authentication, a `domain` header, and a URL-encoded body containing `from`, `to`, `subject`, and `text`. It uses Node's built-in `fetch`; Axios is not required. Set the full credentials in your private environment file; the masked example credentials cannot authenticate. The previous `RESEND_API_KEY` setting is no longer used.

Kirim.Email receives only the transactional verification email. A successful provider response means the provider accepted the request; inbox delivery and opens are not verified. Requests time out after 15 seconds, redirects are refused, and provider errors are returned as `email_unavailable` without private details. Mailpit uses its HTTP send API in local mode, even when Kirim.Email credentials are present. See [Kirim.Email API guide](https://smtp-docs.kirim.email/guide/) for general authentication guidance and [Mailpit API](https://mailpit.axllent.org/docs/api-v1/).

The app may also return an accepted request without calling the provider when another browser's recent requests have reached the email cooldown or hourly limit. This avoids directly disclosing another browser's email activity through throttle responses. If you switch browsers and receive no new email, wait for the cooldown or quota to reset and request again. Such a suppressed request cannot claim a reward. Provider response timing and provider failures can still differ, so this does not provide a constant-time guarantee against email-activity inference.

Local Compose publishes the app and inbox on loopback only. In live mode, host/origin checks require the configured public host and exact origin for POST requests. Responses include a Content Security Policy, framing protection, no-referrer policy and HSTS; request bodies and connection deadlines are bounded. See [SECURITY.md](SECURITY.md) for security assumptions and remaining operational checks.

## Claim behavior and storage

- OTP: random six digits, expires after 10 minutes, locks after five incorrect attempts.
- Requesting another code in the same browser: minimum 60 seconds; at most three accepted requests per email/browser per hour. Across browsers, at most three real send attempts per normalized email per hour; failed email sends also consume the allowance, and extra requests may be suppressed as described above.
- Abuse controls: 20 code-request attempts and 60 claim attempts per client IP per hour. These counters are stored in SQLite and survive app restarts; trusted proxy handling determines the client address as described above.
- HTTP limits: 300 requests per client IP per minute, excluding `/healthz`; analytics ingestion additionally allows 600 events per client IP per minute. These short-window limits are process-local and return 429 with `Retry-After` when exceeded.
- Successful resend invalidates earlier sent codes for the same email and browser session.
- A random HttpOnly, SameSite=Strict cookie binds verification to its requesting browser. Live mode uses the Secure, host-only `__Host-dana_session` cookie to prevent sibling-domain cookie injection.
- Emails are normalized by trim/lowercase. Email, session and OTP values are HMAC hashed in the operational database. This is a limit per email address, not per human.
- Raw email and OTP are sent to the mail provider; local Mailpit holds message contents for testing. They are absent from analytics and application logs.
- Claims use an immediate SQLite transaction. `shared_claims` stores one original link per email; individually allocated inventory uses `claims`, with uniqueness on both email and reward. Both tables are checked before recording a new claim, preserving one claim across configuration changes. Failed/expired verification takes no reward. In inventory mode, stock is checked only after successful OTP verification and can run out before Claim. The code-request response does not reveal stock or existing claims.
- Lost claim responses can be retried with the same valid code. After expiry, verify the same email again to recover its assigned reward.
- Expired challenge records older than 24 hours are pruned during new requests. Allocation history and inventory persist.
- Reward values must be stored privately so they can be displayed later. File permissions restrict access; database/volume backups are sensitive.
- The app allocates supplied codes; it cannot confirm DANA validity, expiry, monetary value, or redemption. Link clicks do not mean redemption.

## Analytics and drop-off

Analytics use `dk_*` names and the `dana_kaget` form identifier. New events go to `dana-events.jsonl`; prior BPU `events.jsonl` files are left untouched and are not mixed into this report. Browser consent, journey and retry keys also use a new `dana.analytics.*` namespace.

No analytics SDK initializes or event is delivered before analytics consent. The optional inspector keeps a bounded, in-memory preview even without consent. Granting consent never replays earlier events. Withdrawal stops providers and clears pending delivery and journey persistence across open tabs. Consent is checked again before initialization, event delivery and local retries; cleared, malformed or expired consent stops delivery. Requests already sent cannot be recalled, and already accepted server events remain.

| Events | Interpretation |
| --- | --- |
| `dk_field_hover/focus/input/change/paste/blur/valid` | Fixed field ID, input/focus counts, validity and focus duration. No characters, clipboard content or field values. Input events are coalesced after 500 ms. |
| `dk_validation_error` | Fixed field and error code. |
| `dk_step_view/submit/complete/back` | Step exposure, attempt, confirmed continuation and back navigation. A valid local submission alone is not continuation. |
| `dk_captcha_ready/success/expired/error/reset` | Widget lifecycle; interaction inside Cloudflare's iframe cannot be inspected. Success here is a widget signal; the request still requires server verification. |
| `dk_code_request/resend`, `dk_email_accepted/failed` | Code-request API outcome. Accepted includes requests suppressed by email throttling and does not prove provider delivery. Failures may include CAPTCHA, rate limits or provider errors. |
| `dk_code_expired`, `dk_claim_attempt/failed/success` | Verification/claim journey. Success is a displayed allocation, including recovery of an earlier claim. |
| `dk_reward_copy/copy_failed/open`, `dk_inbox_open` | Copy result, DANA-link click, or local inbox link click. |
| `dk_visibility/form_exit/form_resume/form_idle/heartbeat` | Tab activity and absence; idle begins around 60 seconds. Hidden/idle tabs stop heartbeats. |
| `dk_page_view/form_view/form_start/form_reset/consent_update/click/scroll` | Supporting interactions with fixed identifiers. |

The server sanitizes events again. Emails, verification codes, reward codes/links, request IDs, cookies, URLs, DOM text, arbitrary properties and nested payloads are excluded. Session-scoped journey IDs are random. A reload within 30 minutes can retain a consented journey, but form inputs and verification state are not restored.

The report shows distinct journeys per step/field, outcomes, fixed error codes, and a chronological timeline. Drop-off is an estimate after **30 minutes without another event**, not proof of intent. Closing a tab, blocked requests, lost delivery or consent withdrawal can hide continuation. A journey is an attempt in a tab, not a unique person.

Client events are best-effort telemetry, not an authoritative reward ledger. A successful server allocation followed by a lost response may lack a success event. Inbox opens and DANA redemption are not tracked. Turnstile iframe cursor positions are not accessible.

Before enabling GA4, disable **Enhanced Measurement** and **automatic user-provided data collection** in its dashboard, then verify the saved settings. Automatic collection runs outside this app's event sanitizer. The app disables automatic page views and passes a fixed page URL, and the DANA action uses a button rather than exposing the reward URL as an anchor for outbound-click tracking. These code controls do not verify or replace the dashboard settings. See [Google's enhanced measurement documentation](https://support.google.com/analytics/answer/9216061). Live GA4/Grovs delivery still requires separate verification.

The vendored Grovs SDK has a reviewed local privacy patch. The adapter sets `captureDeepLinks: false`, so current `Grovs`/`linksquared` URL parameters and saved attribution paths are excluded; paths in previously queued events are removed before transmission too. Deep-link campaign attribution is disabled. See the [patch and reproduction instructions](public/vendor/grovs/PRIVACY-PATCH.md) and [provenance hashes](public/vendor/grovs/provenance.json) before upgrading the SDK.

The event journal accepts batches of up to 20 events with at most 64 pending batches; excess pending work returns 503 for retry. It retains at most 100,000 events and compacts to the most recent 90,000 when that limit is exceeded, discarding the oldest records. Report timelines and counts therefore cover the retained window and can lose earlier parts of a journey. Export/archive events privately before rotation if you need a longer history. This bounded journal is not an archival analytics database.

## Validation

```sh
npm test
npm run check
npm run build
docker compose config --quiet
```

See [VALIDATION.md](VALIDATION.md) for observed results and unverified live integrations.
