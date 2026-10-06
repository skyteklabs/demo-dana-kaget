const labels = { android: 'Google Play', ios: 'App Store' };
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function renderStorePage(platform, stores) {
  if (!['android', 'ios', 'platform'].includes(platform)) throw new TypeError('Invalid store page');
  const options = platform === 'platform' ? ['android', 'ios'] : [platform];
  const heading = platform === 'platform' ? 'Pilih toko aplikasi' : `Buka ${labels[platform]}`;
  const description = platform === 'platform'
    ? 'Pilih toko yang sesuai dengan perangkat Anda.'
    : `Lanjutkan melalui tautan ${labels[platform]} di bawah.`;
  const links = options.map(option => `<a class="button store-link" data-store="${option}" href="${escapeHtml(stores[option])}" rel="noreferrer">${labels[option]} <span>${option === 'android' ? 'Android' : 'iPhone dan iPad'}</span></a>`).join('\n        ');
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${heading} | Dana Kaget</title>
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/store-redirect.css">
  <script type="module" src="/store-redirect.js"></script>
</head>
<body class="store-page" data-store-page="${platform}">
  <a class="skip" href="#store">Lewati ke pilihan toko</a>
  <header class="header">
    <a class="brand" href="/dana-kaget">Dana <span>Kaget</span></a>
  </header>
  <main id="store" class="store-main">
    <h1>${heading}</h1>
    <p id="store-status" class="lead" role="status">${description}</p>
    <nav class="store-links" aria-label="Toko aplikasi">
        ${links}
    </nav>
    ${platform === 'platform' ? '' : '<a class="store-other" href="/platform">Pilih toko lain</a>'}
  </main>
</body>
</html>
`;
}
