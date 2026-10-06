const defaults = {
  android: 'https://play.google.com/store/apps/details?id=com.google.android.apps.translate&hl=en',
  ios: 'https://apps.apple.com/us/app/google-translate/id414706506',
};

export function appStoreConfig(env = process.env) {
  const read = (key, platform, host) => {
    const value = env[key] || defaults[platform];
    const invalid = () => Object.assign(new Error('invalid_store_configuration'), { code: 'invalid_store_configuration', status: 503 });
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) throw invalid();
    let url;
    try { url = new URL(value); } catch { throw invalid(); }
    if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password) throw invalid();
    return url.href;
  };
  return {
    android: read('ANDROID_STORE_URL', 'android', 'play.google.com'),
    ios: read('IOS_STORE_URL', 'ios', 'apps.apple.com'),
  };
}
