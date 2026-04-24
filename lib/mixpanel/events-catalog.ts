/**
 * Whitelist of Mixpanel event names used by the KPI bot.
 *
 * Source: Lexicon top-40 by 30-day query volume (validated 2026-04-23).
 * The LLM-generated tool calls MUST pick from this list so we never invent an
 * event name that doesn't exist and generate a 0-row result silently.
 *
 * If you need to add an event, verify it exists in Mixpanel Lexicon first.
 */

export const MIXPANEL_EVENTS = [
  'PPPaymentProvider',
  'FreeTrialConverted',
  'OBCreateUser',
  'OpenApp',
  'FreeTrialStart',
  'QuizQuestion',
  'S_SWPaywall',
  'ActivityView',
  'S_TAPHome',
  'Lesson',
  'EntryLog',
  'CreateBaby',
  'OpenZoom',
  'MilestonesUpdate',
  'ArticleView',
  'FreeTrialCanceled',
  'IAFinishAssessment',
  'TAPCallToAction',
  'S_OBCreateBaby',
  'S_OBCreateUser',
  '(Leanplum) Email Open',
  'PlanExpired',
  'IAStartAssessment',
  'S_EventDetail',
  '(Leanplum) Email Send',
  'Entry',
  'WidgetTapped',
  'Notification Sent',
  'Subcategory',
  'Progress',
  'ArticlesCollection',
  'S_IAPreviewMilestone',
  'CancelSubscription',
  'S_IAPreviewFeedback',
  'S_IAPreviewIntro',
  'SkillsCardNotPersonalize',
  'Notification Clicked',
  'S_ProgressHome',
  'ViewMilestones',
  'SelectLanguage',
] as const;

export type MixpanelEvent = typeof MIXPANEL_EVENTS[number];

export function isKnownMixpanelEvent(name: string): name is MixpanelEvent {
  return (MIXPANEL_EVENTS as readonly string[]).includes(name);
}

/**
 * Short human-readable hints shown to the LLM so it picks the right event
 * for common KPI questions. Keep concise — every token costs.
 */
export const EVENT_HINTS: Partial<Record<MixpanelEvent, string>> = {
  OBCreateUser: 'signups / new user signups (onboarding account creation)',
  FreeTrialStart: 'free trials started',
  FreeTrialConverted: 'free trials converted to paid',
  FreeTrialCanceled: 'free trials canceled',
  CancelSubscription: 'subscription cancellations',
  PlanExpired: 'subscriptions expired',
  OpenApp: 'app opens (DAU / MAU proxy)',
  ActivityView: 'activity detail views',
  S_SWPaywall: 'paywall (Superwall) views',
  PPPaymentProvider: 'payment provider screen shown at checkout',
  CreateBaby: 'baby profile created',
  SelectLanguage: 'language selected in onboarding',
};
