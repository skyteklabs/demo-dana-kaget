# Validation record — Dana Kaget

Updated 2026-10-06. Results below distinguish source tests from observed runtime behavior.

## Security review — verified 2026-10-06

The current security findings, fixes, deployment requirements and remaining limits are in [SECURITY.md](SECURITY.md). All **99 tests** pass; syntax checks and the build pass. Live reports now have application-level access control, trusted-proxy extraction prevents caller-controlled forwarded-header spoofing, request/event storage is bounded, consent is reconciled across tabs, and the real Grovs bundle is tested with its maintained privacy patch. Stock and email-throttle response disclosure were reduced with verified-OTP stock decisions and non-allocating decoys. Provider timing differences remain documented.

Docker registry access recovered during this review. Patched Mailpit v1.31.4 and Node 22.23.3 images were pulled and pinned by digest. The app image built successfully. An isolated, network-disabled container passed live-mode HTTP API/authentication, cookie/header, Host, non-root, filesystem and writable-volume checks; its temporary container/volume were removed. No public deployment or provider delivery was performed. Browser smoke testing was blocked because the admin-enforced browser policy could not be verified.

This section supersedes earlier descriptions of unauthenticated live reports, shared proxy limits, fixed-full journals, the unpatched Grovs bundle, and blocked Docker builds. Sections marked historical below preserve earlier checkpoints.

## Traefik Compose configuration — verified 2026-10-06

The standalone `docker-compose.traefik.yml` targets `dana.skytek.id`, using external network `edge`, the existing `websecure` TLS entrypoint, and internal HTTP port 4173. It runs the app in live mode, derives its HTTPS origin from `APP_HOST`, and persists data. Its Host-only router forwards report requests to the app's authentication gate; public `/analytics/*.js` imports remain accessible. `.env.example` includes the chosen hostname.

Rendered Compose configuration was checked with synthetic credentials: required-variable checks, internal port exposure without host publishing, network selection, live mode despite local environment overrides, derived origin, labels, data mount and container restrictions passed. The rendered environment also passed application configuration and report authorization validation. Missing trusted-proxy settings are rejected by Compose; invalid proxy ranges are rejected by the app. This is static configuration validation, not a running Traefik test. No stack was deployed; DNS, TLS certificates, the existing Traefik network, production credentials, real client-IP propagation and public routing remain unverified.

## Live configuration template — verified 2026-10-06

`.env.example` now defaults to `APP_MODE=live`, `PUBLIC_ORIGIN=https://dana.skytek.id`, and blank production Turnstile credentials, alongside the Kirim.Email settings. Local testing overrides are documented at the bottom. Parsing confirms that the incomplete live template is rejected, a filled synthetic live configuration loads, and the documented local overrides load. Compose configuration validation passed. This changes the template and setup instructions; it does not activate live mode in the private runtime environment or verify production credentials.

## Kirim.Email delivery — historical checkpoint, 2026-10-06

Live verification email now uses the supplied Kirim.Email v4 transactional endpoint with form encoding, the domain header, and server-only Basic authentication. Configuration and Compose use `KIRIM_EMAIL_DOMAIN`, `KIRIM_EMAIL_USERNAME`, `KIRIM_EMAIL_PASSWORD`, and `EMAIL_FROM`; `.env.example` includes `skytek.id` and blank credentials. Local mode continues to use Mailpit.

`npm test` passed **52/52 tests** (46 top-level tests plus six failure subtests), `npm run check` and `npm run build` passed, and `docker compose --env-file .env.example config --quiet` passed. Tests verify required live settings, form encoding of special characters, authentication, a 15-second timeout, redirect refusal, redacted failures, private configuration, and local Mailpit isolation. Requests use injected transports; no live Kirim.Email email was sent. The private environment is still local and has no Kirim.Email credentials configured, so authenticated provider acceptance and inbox delivery remain unverified.

Refreshing Docker was blocked: the default build hit a macOS credential-helper error, and a retry with a temporary anonymous Docker configuration reached a DNS failure resolving `auth.docker.io`. Saved Docker credentials were not changed. The existing app and Mailpit containers remained healthy and `/healthz` returned `{"status":"ok"}`, but they still use the previous app image. Rebuild with `docker compose up -d --build app` once registry access works; the source and `dist/` contain the new adapter.

## Turnstile loading fix — historical checkpoint, 2026-10-04

The widget container previously used `id="turnstile"`, which conflicts with the SDK's `window.turnstile` global through HTML named access. The loader accepted any truthy global as a loaded SDK, so an HTML element could suppress the script download. The container now uses `turnstile-widget`; the extracted loader checks for callable SDK methods, shares pending requests, and clears failed requests for retry. Rendering and reset use the validated SDK reference.

Five regression tests cover the named-element collision, concurrent loading/reuse, failed downloads, missing SDK after a load event, and timeout/retry. All **42 tests** passed, along with syntax checking and the build. `docker compose up -d --build app` successfully rebuilt and recreated the app container. Chrome then visibly displayed the Cloudflare test widget with **Success!** and the application's **Verifikasi keamanan selesai.** status. Screenshot: `artifacts/turnstile-working.png`.

This resolves the earlier widget-loading failure below. It verifies the localhost widget, not production CAPTCHA credentials, email delivery or DANA redemption.

## Localhost configuration follow-up — historical checkpoint

The requested Cloudflare test keys are now explicit in `.env` with `APP_MODE=local`. Node commands load `.env` followed by optional `.env.local` overrides. Both Node configuration and resolved Compose configuration were checked and matched the requested keys. `npm run build` passed, and a fresh `docker compose up -d --build app` completed with both containers started, superseding the earlier pending-rebuild note below. The subsequent in-container health/config check was denied access to the Docker socket, so post-start health and widget behavior were not reverified.

## Automated checks on the final source

- `npm test`: **99/99 passed**.
- `npm run check`: passed syntax checking of authored JavaScript and modules.
- `npm run build`: passed; generated `dist/` includes the server, public assets, libraries and import scripts.
- `docker compose config --quiet`: passed.

Coverage includes cookie-bound claims, server CAPTCHA failures, live hostname/action checking with test doubles, OTP expiry, five-attempt lockout, resend invalidation and throttling, provider failure redaction, empty inventory, duplicate imports, privacy filtering, same-email recovery and persistence. Two independent worker threads raced for one remaining reward; exactly one succeeded. The stdin import command was exercised in a temporary directory and prints counts without reward values.

Analytics tests cover no initialization/delivery before consent, no replay on grant, withdrawal during initialization, regrant, retry queues, event deduplication, reload identity, post-claim copy events, field timing, idle/hidden tabs, unique-journey funnels and the distinction between submission and confirmed continuation.

Provider requests are tested with injected transports. Those tests do not prove live Kirim.Email or Cloudflare connectivity.

## Docker and browser observations — historical checkpoint

- `docker compose up -d --build` completed: app image built, Mailpit v1.26 pulled, both containers started.
- Chrome opened `http://localhost:4173/dana-kaget` and visibly rendered the Dana Kaget branding, email field, three stages, consent controls and CAPTCHA error state.
- The browser inspector showed consented focus, paste/input, blur, fixed validation errors and visibility events, with **15 events acknowledged by the local collector** at the observed point.
- The Cloudflare widget did not load in this browser session. Its cause was not established.
- Browser security review rejected raw CDP network inspection because permission was declined. No alternative network-inspection route was used.
- Chrome subsequently blocked further UI automation because another extension UI was open. Full form submission, mobile browser checks, report rendering, inbox receipt and the browser claim-success screen remain unverified.
- A later Docker command was denied access to the OrbStack socket, so importing demo inventory and rebuilding the final small frontend refinements could not be completed. The running container may lag the final source. A shell HTTP health request also could not connect, despite the observed Chrome page load.

To load the final source and test data:

```sh
docker compose up -d --build
docker compose exec app npm run import:codes -- --demo
```

Then open the form, allow analytics, enter a synthetic email, wait for the Cloudflare test widget, request a code, read it in http://localhost:8025, enter it and press Claim. Verify that the demo reward is labeled non-redeemable, a retry returns the same reward, and the report records continuation and success without email/OTP/reward values.

## UI review applied during implementation

The previously selected “apply guidance while building” approach was retained. The form uses a blue text wordmark, a restrained three-stage layout, visible labels, keyboard focus outlines, described errors, explicit loading/error/success states and system fonts. No official logo or invented reward amount is displayed. A compact CAPTCHA layout is selected below 375 px; browser validation at that breakpoint is still pending.

Primary button/link blue `#0066ad` against white: **5.99:1**. Muted text `#4c6275` against `#f5f8fc`: **5.95:1**. Input boundary `#708598` against white: **3.82:1**, passing the 3:1 non-text criterion. These ratios were checked with the antislop-human contrast script. Desktop rendering was visually inspected; these checks are not a full accessibility audit.

## Not yet validated

- A real DANA inventory file: the user confirmed `https://dana.id/<random_code>` entries, which are supported, but has not supplied a file path. Placeholder URLs are rejected.
- Live Kirim.Email delivery, verified sending domain, real Turnstile credentials/hostname, GA4 and Grovs delivery.
- Redemption or validity of imported codes in DANA; the app has no DANA redemption callback or API.
- Public deployment, deployed operator reporting and trusted-proxy settings, load testing and disaster recovery. Local source/API/container checks are recorded above.

The application and local Compose fall back to local mode when no mode is supplied; `.env.example` and Traefik Compose target live mode. Import and configuration instructions are in [README.md](README.md).
