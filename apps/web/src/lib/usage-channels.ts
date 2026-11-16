/** The usage channels, in the order the chart and the totals show them. Constants only. */
export const USAGE_CHANNELS = ['voice', 'sms', 'whatsapp', 'other'] as const;
export type UsageChannel = (typeof USAGE_CHANNELS)[number];
