import { scrubText } from '@knoqra/core/scrub';
import { type WebObservabilityConfig, webObservability } from './config';

/**
 * The Desk's product analytics: PostHog behind opt-in consent, a closed event allowlist and the
 * same scrubbing as error reports. Nothing here is sent for a user who has not opted in, and with
 * no key configured the SDK is never downloaded.
 */

export type PosthogConfig = NonNullable<WebObservabilityConfig['posthog']>;

/**
 * Every event KNOQRA may send, with the rule for each prop: `'route'` is a route id (never a URL),
 * an array is the closed set of allowed values.
 */
export const ANALYTICS_EVENTS = {
  page_viewed: { route: 'route' },
  contact_created: {},
  system_status_refreshed: { status: ['ok', 'degraded', 'down'] },
} as const;

export type AnalyticsEvent = keyof typeof ANALYTICS_EVENTS;

type PropRule = 'route' | readonly string[];
type PropValue<R extends PropRule> = R extends readonly string[] ? R[number] : string;
export type AnalyticsProps<E extends AnalyticsEvent> = {
  -readonly [K in keyof (typeof ANALYTICS_EVENTS)[E]]: PropValue<
    Extract<(typeof ANALYTICS_EVENTS)[E][K], PropRule>
  >;
};

/** A route id such as `/contacts/$contactId`: path characters only, no query, no host. */
const ROUTE_PATTERN = /^\/[A-Za-z0-9/_$.-]{0,120}$/;

/** Privacy-first SDK options: no autocapture, recordings, URLs, referrers or IP. */
export const POSTHOG_OPTIONS = {
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_web_experiments: true,
  disable_product_tours: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  capture_exceptions: false,
  capture_performance: false,
  capture_dead_clicks: false,
  rageclick: false,
  mask_all_text: true,
  save_referrer: false,
  ip: false,
  person_profiles: 'identified_only',
  persistence: 'localStorage',
  property_denylist: [
    '$current_url',
    '$pathname',
    '$referrer',
    '$referring_domain',
    '$initial_current_url',
    '$initial_pathname',
    '$initial_referrer',
    '$initial_referring_domain',
  ],
} as const;

/** Properties that carry a URL, path, referrer or campaign tag; PostHog adds several on its own. */
const URL_KEY =
  /^\$session_entry_|^\$initial_|^\$?utm_|^(gclid|fbclid|msclkid|gbraid|wbraid|dclid|li_fat_id|ttclid|twclid|igshid)$|url$|pathname$|referrer$|referring_domain$/i;

function withoutUrlKeys(bag: unknown): unknown {
  if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) return bag;
  return Object.fromEntries(Object.entries(bag).filter(([key]) => !URL_KEY.test(key)));
}

/**
 * PostHog `before_send`: removes every URL-bearing property from the event and from the person
 * properties it sets (`identify` sends the initial URL in `$set_once`). Never drops the event.
 */
export function stripUrlProperties<T extends { properties?: unknown } | null>(event: T): T {
  if (!event?.properties || typeof event.properties !== 'object') return event;
  const properties = withoutUrlKeys(event.properties) as Record<string, unknown>;
  for (const key of ['$set', '$set_once']) {
    if (key in properties) properties[key] = withoutUrlKeys(properties[key]);
  }
  return { ...event, properties };
}

/** The few instance methods KNOQRA calls, from ./posthog-sdk (the default instance only). */
type Posthog = typeof import('./posthog-sdk')['posthog'];

let sdk: Posthog | null = null;
let loading: Promise<Posthog> | null = null;
let initialised = false;
/** The user PostHog currently knows, or null. */
let identified: string | null = null;
/** True only while consent is granted, the SDK is loaded and a user is identified. */
let active = false;
/** Orders overlapping `syncAnalytics` calls: only the latest one may finish. */
let latest = 0;

function loadSdk(): Promise<Posthog> {
  loading ??= import('./posthog-sdk').then(
    (module) => {
      sdk = module.posthog;
      return module.posthog;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

function optOut(): void {
  active = false;
  identified = null;
  // A loaded chunk is not enough: a superseded sync can load the SDK without ever running init.
  if (!sdk || !initialised) return;
  // reset() first: it clears the stored consent, so the opt-out must be written after it.
  sdk.reset();
  sdk.opt_out_capturing();
}

/**
 * Brings PostHog in line with the signed-in user's consent. No state or no consent turns capturing
 * off and forgets the identity; consent with a configured key loads the SDK (once), opts in and
 * identifies the internal user id. Rejects only when the SDK chunk fails to load.
 */
export async function syncAnalytics(
  state: { userId: string; consent: boolean } | null,
  config: PosthogConfig | null = webObservability.posthog,
): Promise<void> {
  const turn = ++latest;
  if (!state?.consent) return optOut();
  if (!config) return;

  const posthog = await loadSdk();
  if (turn !== latest) return;

  if (!initialised) {
    posthog.init(config.key, {
      ...POSTHOG_OPTIONS,
      property_denylist: [...POSTHOG_OPTIONS.property_denylist],
      before_send: stripUrlProperties,
      api_host: config.host,
    });
    initialised = true;
    // The SDK's localStorage may still hold a previous user's ids (tab closed without sign-out).
    posthog.reset();
  }
  if (identified !== null && identified !== state.userId) posthog.reset();
  // No `$opt_in` event: it is not on the allowlist and would carry the pre-identify id.
  posthog.opt_in_capturing({ captureEventName: false });
  if (identified !== state.userId) {
    posthog.identify(state.userId);
    identified = state.userId;
  }
  active = true;
}

function isAllowed(rule: PropRule, value: unknown): boolean {
  if (typeof value !== 'string' || scrubText(value) !== value) return false;
  return rule === 'route' ? ROUTE_PATTERN.test(value) : rule.includes(value);
}

function propsAreValid(event: AnalyticsEvent, props: Readonly<Record<string, unknown>>): boolean {
  const rules: Readonly<Record<string, PropRule>> = ANALYTICS_EVENTS[event];
  const keys = Object.keys(props);
  if (keys.length !== Object.keys(rules).length) return false;
  return keys.every((key) => {
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
    return rule !== undefined && isAllowed(rule, props[key]);
  });
}

/**
 * Sends an allowlisted event. Returns true only when it was sent: it drops (false) when analytics
 * are off, consent is missing, PostHog is still loading, the event is unknown, or a prop breaks
 * its rule or would be changed by `scrubText`. Synchronous, never queues, never throws.
 */
export function track<E extends AnalyticsEvent>(event: E, props: AnalyticsProps<E>): boolean {
  if (!active || !sdk) return false;
  if (!Object.hasOwn(ANALYTICS_EVENTS, event)) return false;
  if (!propsAreValid(event, props)) return false;
  try {
    sdk.capture(event, props);
    return true;
  } catch {
    return false;
  }
}
