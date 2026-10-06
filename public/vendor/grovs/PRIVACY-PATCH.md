# Grovs privacy patch

The pinned upstream SDK automatically copies `Grovs` or `linksquared` URL
parameters into deep-link requests and event `path` fields. It can also restore
the same path from browser storage. `autoTrackScreenViews: false` does not disable
this attribution, so URL values bypass the application's analytics allowlist.

The local patch adds `captureDeepLinks` to resolved SDK configuration. It defaults
to upstream behavior (`true`). Dana Kaget explicitly sets it to `false`, which:

- Skips reading URL parameters and the saved attribution path during configure.
- Removes `path` from outbound event batches, including events queued before the
  update.

No browser URL is rewritten. Consent, authentication, and explicit event/screen
tracking otherwise keep the upstream behavior. Deep-link campaign attribution is
disabled for this application.

`provenance.json` records the upstream commit, original bundle hash, and patched
bundle hash. To reproduce, build the exact upstream commit using its recorded
esbuild command and version, then run from the repository root:

```sh
node scripts/patch-grovs.mjs path/to/unmodified/grovs.js
```

The patch script refuses an unexpected source hash or non-unique replacement.
When upgrading, review the upstream consent/attribution code, update the patch
against the new original bundle, and run `npm test`. The regression tests execute
the real bundled SDK with a stub transport and synthetic browser storage; no
analytics requests leave the test process.
