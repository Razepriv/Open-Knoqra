import type { components } from '@knoqra/api-client';

/** Channel constants for Contact 360. Constants only: the contact outline loads with the route tree. */

export type Channel = components['schemas']['ChannelPermission']['channel'];

/** The API's channel order, which the permissions panel follows. */
export const CHANNEL_ORDER: readonly Channel[] = [
  'manual_call',
  'sms',
  'whatsapp',
  'ai_voice',
  'recording',
];
