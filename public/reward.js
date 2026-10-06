export function isRewardLink(value) {
  if (typeof value !== 'string' || /[<>\s]/.test(value) || /%3[ce]/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['dana.id', 'link.dana.id'].includes(url.hostname)
      && !url.username && !url.password && !url.port && url.pathname !== '/';
  } catch { return false; }
}
