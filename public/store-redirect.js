export function detectStorePlatform({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'ios';
  return null;
}

export function startStoreRedirect({ page, navigator, stores, navigate, setStatus, schedule = setTimeout, cancel = clearTimeout }) {
  const selected = page === 'platform' ? detectStorePlatform(navigator) : ['android', 'ios'].includes(page) ? page : null;
  if (!selected) {
    setStatus('Pilih toko yang sesuai dengan perangkat Anda.');
    return { platform: null, stop() {} };
  }
  let destination;
  try {
    destination = new URL(stores[selected]);
    if (destination.protocol !== 'https:' || destination.username || destination.password) throw new Error();
  } catch {
    setStatus('Tautan toko belum tersedia. Silakan coba lagi nanti.');
    return { platform: selected, stop() {} };
  }
  const label = selected === 'android' ? 'Google Play' : 'App Store';
  setStatus(`Membuka ${label}. Anda juga dapat menggunakan tautan di bawah.`);
  let timer = schedule(() => {
    timer = undefined;
    try {
      navigate(destination.href);
      setStatus('Jika toko belum terbuka, gunakan tautan di bawah untuk melanjutkan.');
    } catch {
      setStatus('Pengalihan otomatis tidak berhasil. Gunakan tautan di bawah untuk melanjutkan.');
    }
  }, 1000);
  return {
    platform: selected,
    stop() { if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}

export function mountStoreRedirect({ document, window }) {
  const links = [...document.querySelectorAll('[data-store]')];
  const status = document.querySelector('#store-status');
  if (!status) return;
  const stores = Object.fromEntries(links.map(link => [link.dataset.store, link.getAttribute('href')]));
  const controller = startStoreRedirect({
    page: document.body.dataset.storePage, stores, navigator: window.navigator,
    navigate: url => window.location.replace(url),
    setStatus: text => { status.textContent = text; },
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    cancel: timer => window.clearTimeout(timer),
  });
  for (const link of links) link.addEventListener('click', controller.stop);
  window.addEventListener('pagehide', controller.stop, { once: true });
  return controller;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') mountStoreRedirect({ document, window });
