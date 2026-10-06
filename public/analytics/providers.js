function script(document, src) {
  return new Promise((resolve, reject) => {
    const element = document.createElement('script');
    const timeout = setTimeout(() => {
      element.remove();
      reject(new Error('SDK load timeout'));
    }, 12_000);
    element.async = true;
    element.src = src;
    element.onload = () => { clearTimeout(timeout); resolve(); };
    element.onerror = () => { clearTimeout(timeout); element.remove(); reject(new Error('SDK load failed')); };
    document.head.append(element);
  });
}

export function googleProvider(config, { window, document, loadScript = src => script(document, src) }) {
  const measurementId = config.ga4MeasurementId || '';
  let ready = false;
  const configured = /^G-[A-Z0-9]+$/.test(measurementId);
  const gtag = (...args) => window.gtag(...args);
  return {
    id: 'ga4', configured,
    async initialize(allowed) {
      if (!configured || !allowed()) return false;
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      window[`ga-disable-${measurementId}`] = false;
      gtag('consent', 'default', {
        analytics_storage: 'denied', ad_storage: 'denied',
        ad_user_data: 'denied', ad_personalization: 'denied',
      });
      await loadScript(`https://www.googletagmanager.com/gtag/js?id=${measurementId}`);
      if (!allowed()) return false;
      gtag('js', new Date());
      gtag('consent', 'update', { analytics_storage: 'granted' });
      gtag('config', measurementId, {
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        page_location: `${window.location.origin}/dana-kaget`,
        page_referrer: '',
        page_title: 'Dana Kaget',
        cookie_flags: 'SameSite=Lax;Secure',
        ...(config.debug ? { debug_mode: true } : {}),
      });
      ready = true;
      return true;
    },
    send(event) {
      if (!ready) return;
      gtag('event', event.name, {
        ...event.properties,
        event_id: event.id,
        page_location: `${window.location.origin}/dana-kaget`,
        page_referrer: '',
        send_to: measurementId,
      });
    },
    stop() {
      ready = false;
      window[`ga-disable-${measurementId}`] = true;
      if (window.gtag) gtag('consent', 'update', { analytics_storage: 'denied' });
      // Remove only Google's first-party cookies, at each possible parent domain.
      for (const entry of document.cookie.split(';')) {
        const name = entry.trim().split('=')[0];
        if (!/^_ga(?:_|$)/.test(name)) continue;
        document.cookie = `${name}=; Max-Age=0; path=/`;
        const parts = window.location.hostname.split('.');
        while (parts.length > 1) {
          document.cookie = `${name}=; Max-Age=0; path=/; domain=.${parts.join('.')}`;
          parts.shift();
        }
      }
    },
  };
}

export function grovsProvider(config, { loadSDK = () => import('../vendor/grovs/grovs.js') } = {}) {
  let sdk;
  let configured = false;
  let active = false;
  return {
    id: 'grovs', configured: Boolean(config.grovsApiKey),
    async initialize(allowed) {
      if (!config.grovsApiKey || !allowed()) return false;
      const module = await loadSDK();
      if (!allowed()) return false;
      sdk = module.default;
      if (typeof sdk.configure !== 'function' || typeof sdk.track !== 'function') {
        throw new Error('Grovs Web SDK 2.0 is required');
      }
      await sdk.configure({
        apiKey: config.grovsApiKey,
        testEnvironment: config.grovsTestEnvironment !== false,
        autoTrackScreenViews: false,
        captureDeepLinks: false,
        requireConsent: true,
        appVersion: 'dana-kaget-1.0.0',
        debugLevel: 'error',
        onError: () => {},
      });
      configured = true;
      if (!allowed()) { sdk.reset(); return false; }
      const ready = await sdk.grantConsent();
      if (!allowed()) { sdk.reset(); return false; }
      active = Boolean(ready);
      return ready;
    },
    send(event) {
      if (!active) return;
      if (event.name === 'dk_step_view') sdk.trackScreenView(`dk_${event.properties.step_id}`);
      sdk.track(event.name, { ...event.properties, event_id: event.id }, ['dana_kaget']);
    },
    flush() {
      return active ? sdk.flush() : Promise.resolve();
    },
    stop() {
      active = false;
      if (configured) sdk.reset();
    },
  };
}
