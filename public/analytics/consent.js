export const CONSENT_KEY = 'dana.analytics.consent.v2';
export const CONSENT_VERSION = 'analytics-meta-v2';
export const QUEUE_KEY = 'dana.analytics.queue.v2';

export function claimAnalyticsConsent(tracker, metaEnabled) {
  tracker.syncConsent();
  return {
    analyticsConsent: tracker.consent === 'granted' && metaEnabled === true ? 'granted' : 'denied',
    consentVersion: CONSENT_VERSION,
  };
}
