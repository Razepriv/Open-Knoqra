/**
 * US texting (10DLC) registration: who is registering, the texts carriers review, and how far a
 * registration has got. Provider-neutral: the provider adapter maps its own statuses onto these.
 */

export const SMS_ENTITY_TYPES = [
  'sole_proprietor',
  'private_profit',
  'public_profit',
  'non_profit',
] as const;
export type SmsEntityType = (typeof SMS_ENTITY_TYPES)[number];

/**
 * Where a registration stands. `otp_required`: a sole proprietor must enter the code texted to
 * their mobile. `approved`: the number is on an approved campaign and may send. `rejected`: a
 * registry or carrier said no. `failed`: a step could not be submitted (fix the details and retry).
 */
export const SMS_REGISTRATION_STATES = [
  'submitting',
  'otp_required',
  'brand_pending',
  'campaign_pending',
  'number_pending',
  'approved',
  'rejected',
  'failed',
] as const;
export type SmsRegistrationState = (typeof SMS_REGISTRATION_STATES)[number];

export const isSmsRegistrationDone = (state: SmsRegistrationState): boolean =>
  state === 'approved' || state === 'rejected';

/** Carriers' bounds on the opt-in, HELP and STOP texts. */
export const COMPLIANCE_TEXT_MIN = 20;
export const COMPLIANCE_TEXT_MAX = 320;
/** The campaign description and the opt-in flow must say enough for a reviewer. */
export const CAMPAIGN_TEXT_MIN = 40;

export interface SmsComplianceTexts {
  /** How people agree to receive texts (the call to action a reviewer checks). */
  messageFlow: string;
  /** What the texts are for. */
  description: string;
  optinMessage: string;
  helpMessage: string;
  optoutMessage: string;
  sample1: string;
  sample2: string;
}

/**
 * CTIA-compliant defaults for a brand: each text names the brand, the opt-in confirmation gives the
 * frequency, "Msg & data rates may apply" and the HELP and STOP instructions, HELP gives a contact,
 * and STOP confirms that nothing more will be sent. Every sample carries the opt-out line.
 */
export function defaultComplianceTexts(input: {
  brandName: string;
  email: string;
  website?: string | null;
}): SmsComplianceTexts {
  const brand = input.brandName.trim() || 'Our team';
  const contact = input.email.trim();
  const site = input.website?.trim();
  return {
    messageFlow: `Customers give their mobile number to ${brand} in person, by phone or on ${
      site ? site : 'our website'
    } and agree to receive texts about their requests and appointments. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    description: `${brand} texts customers who asked to hear from us: replies to their questions, appointment reminders and updates about their account.`,
    optinMessage: `${brand}: You're subscribed to texts about your requests and appointments. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    helpMessage: `${brand}: For help, email ${contact || 'us'}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`,
    optoutMessage: `${brand}: You are unsubscribed and will receive no further messages. Reply START to resubscribe.`,
    sample1: `${brand}: Hi, this is a reminder about your appointment tomorrow at 10:00. Reply STOP to opt out.`,
    sample2: `${brand}: Thanks for your message. We'll call you back today. Reply HELP for help, STOP to opt out.`,
  };
}

/** Why a compliance text would be refused, or null when it is fine. */
export function complianceTextProblem(
  field: keyof SmsComplianceTexts,
  value: string,
  brandName: string,
): string | null {
  const text = value.trim();
  const isReply = field === 'optinMessage' || field === 'helpMessage' || field === 'optoutMessage';
  if (isReply) {
    if (text.length < COMPLIANCE_TEXT_MIN || text.length > COMPLIANCE_TEXT_MAX) {
      return `Use ${COMPLIANCE_TEXT_MIN} to ${COMPLIANCE_TEXT_MAX} characters.`;
    }
    const brand = brandName.trim().toLowerCase();
    if (brand.length > 0 && !text.toLowerCase().includes(brand)) return 'Name your business.';
  }
  if ((field === 'messageFlow' || field === 'description') && text.length < CAMPAIGN_TEXT_MIN) {
    return `Use at least ${CAMPAIGN_TEXT_MIN} characters.`;
  }
  if (field === 'optinMessage' && !/stop/i.test(text)) return 'Say how to opt out (Reply STOP).';
  if (field === 'optinMessage' && !/rates may apply/i.test(text)) {
    return 'Include "Msg & data rates may apply".';
  }
  if ((field === 'sample1' || field === 'sample2') && text.length === 0) return 'Add a sample.';
  return null;
}
