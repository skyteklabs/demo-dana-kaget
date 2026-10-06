# QR encoder

`qrcodegen.js` is compiled from Project Nayuki's MIT-licensed QR Code generator,
release 1.8.0, commit `720f62bddb7226106071d4728c292cb1df519ceb`.
The exact source URL, compiler version, command and SHA-256 hashes are recorded in
`provenance.json`. The only addition to the compiled output is the ES module export:

```js
export const { QrCode, QrSegment } = qrcodegen;
```

To reproduce, download the pinned `qrcodegen.ts` source, verify `source_sha256`, run
the recorded TypeScript command, append a newline and the export line above with
a trailing newline, and verify `vendored_sha256`. The library needs no network
access, runtime package installation or build step in the application.

The application renders SVG locally after the reward is revealed. It uses medium
error correction (boosted when it fits the same version), a four-module white quiet
zone, and a maximum version of 12. Longer links keep their clickable fallback.

Synthetic URLs containing query separators, percent escapes and UTF-8 text, plus
a maximum-version sample, were rasterized to RGBA at 224px and 256px and independently decoded with
jsQR 1.4.0 (`cozmo/jsQR`, commit `34d8eec1ec5d85496f3948ff02fcfe6406f89d81`,
`dist/jsQR.js`). The decoder was
used from a temporary file and is not shipped. `tests/reward-qr.test.mjs` pins those
verified matrices and checks that the SVG reconstructs them without losing their
quiet zone. No real reward links were used in verification.
