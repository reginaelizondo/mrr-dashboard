/**
 * Whitelist of Mixpanel properties available for breakdown/segmentation.
 *
 * Mixpanel has two property kinds:
 *  - EVENT properties  — stamped on each event at ingestion time. Ref: `properties["X"]`.
 *  - USER (people)     — attached to the user profile. Ref: `user["X"]`.
 *
 * IMPORTANT: Most Kinedu "user" properties (language, country, planType, sku, …)
 * are ALSO stamped on events as super-properties. The Mixpanel UI breaks down
 * by EVENT-level by default, so we do the same here — otherwise our numbers
 * won't match what users see in Lexicon/Insights dashboards.
 *
 * Using the wrong prefix (or a non-existent property) silently returns a single
 * "undefined" bucket from the API, which is what bit us originally.
 *
 * Source: Kinedu Mixpanel Lexicon CSV (2026-04-23). Filtered to properties that
 * appear on ≥200 events with query-volume > 0, plus a few common aliases.
 */

/**
 * Event-level properties that behave as super-properties (stamped on almost
 * every event). These are the default breakdown dimension — matches UI.
 */
export const EVENT_PROPERTIES = [
  '$os',                 // iOS / Android / Web / Unknown  (Mixpanel built-in)
  '$app_version_string', // e.g. '1.11'
  'source',              // product source / section
  'sku',                 // purchased SKU
  'planType',            // subscription tier (monthly/yearly/etc.)
  'planStatus',          // active / canceled / expired / ...
  'kineduCountry',       // ISO-2 country (Kinedu-set)
  'kineduLanguage',      // 'en' | 'es' | 'pt'
  'kinedu_type',
  'mp_country_code',     // country auto-detected by Mixpanel
  'utm_source',
  'npsScore',
  'kineduCustomLocale',
] as const;

/**
 * User-only properties — not stamped on events. Reach via `user["X"]`.
 * Keep this list small and only include ones that DON'T exist as event props.
 * (Most useful Kinedu props are super-properties, so this list is near-empty.)
 */
export const USER_PROPERTIES = [
  '$country_code',   // Mixpanel's user-level country (distinct from event mp_country_code)
  '$android_os',     // user-level Android OS
  '$ios_app_version',
] as const;

/**
 * Properties that ALSO exist at user-profile level. When a segmentation
 * returns only "undefined" (event doesn't carry the super-prop for that
 * specific event, e.g. FreeTrialConverted + planType), we auto-fall back to
 * `user["X"]` to still get useful buckets.
 */
export const PROPERTY_HAS_USER_FALLBACK = new Set<string>([
  'planType',
  'planStatus',
  'kineduCountry',
  'kineduLanguage',
  'sku',
  'source',
  'npsScore',
  'kineduCustomLocale',
  '$os',
]);

export type EventProperty = typeof EVENT_PROPERTIES[number];
export type UserProperty = typeof USER_PROPERTIES[number];

export function isEventProperty(name: string): name is EventProperty {
  return (EVENT_PROPERTIES as readonly string[]).includes(name);
}
export function isUserProperty(name: string): name is UserProperty {
  return (USER_PROPERTIES as readonly string[]).includes(name);
}
export function isKnownProperty(name: string): boolean {
  return isEventProperty(name) || isUserProperty(name);
}

/**
 * Build the Mixpanel `on` segmentation expression for a known property.
 * Event-level is preferred (matches UI). Throws on unknown names so we never
 * silently break down by a property that doesn't exist.
 */
export function segmentationExprFor(property: string): string {
  if (isEventProperty(property)) return `properties["${property}"]`;
  if (isUserProperty(property)) return `user["${property}"]`;
  throw new Error(
    `Unknown Mixpanel property "${property}". Add it to EVENT_PROPERTIES or USER_PROPERTIES first.`
  );
}

/** User-level fallback expression (assumes the property name is valid). */
export function userLevelExprFor(property: string): string {
  return `user["${property}"]`;
}

export function hasUserFallback(property: string): boolean {
  return PROPERTY_HAS_USER_FALLBACK.has(property);
}

/**
 * Natural-language aliases used only inside the LLM prompt so Claude maps
 * Spanish/English phrasings to real property names.
 */
export const PROPERTY_ALIASES: Record<string, string> = {
  'platform / SO / operating system': '$os',
  'language / idioma': 'kineduLanguage',
  'country / país (Kinedu)': 'kineduCountry',
  'country / país (auto-detected)': 'mp_country_code',
  'plan / subscription tier': 'planType',
  'plan status / estado de suscripción': 'planStatus',
  'source / sección': 'source',
  'app version / versión': '$app_version_string',
  'utm source / acquisition channel': 'utm_source',
};
