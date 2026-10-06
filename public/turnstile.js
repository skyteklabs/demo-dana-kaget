export function createTurnstileLoader({ window, document, schedule = setTimeout, cancel = clearTimeout, timeoutMs = 12_000 }) {
  let pending;
  const sdk = () => {
    const candidate = window.turnstile;
    // An element ID can create window.turnstile before Cloudflare loads.
    return ['render', 'reset', 'remove'].every(method => typeof candidate?.[method] === 'function') ? candidate : null;
  };
  return function loadTurnstile() {
    if (sdk()) return Promise.resolve(sdk());
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        cancel(timer);
        script.onload = null;
        script.onerror = null;
        if (error) { script.remove(); reject(new Error(error)); }
        else resolve(sdk());
      };
      const timer = schedule(() => finish('turnstile_load_timeout'), timeoutMs);
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => finish(sdk() ? null : 'turnstile_sdk_missing');
      script.onerror = () => finish('turnstile_load_failed');
      document.head.append(script);
    }).catch(error => { pending = undefined; throw error; });
    return pending;
  };
}
