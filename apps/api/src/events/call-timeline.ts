import type { CallState } from '@knoqra/core';
import { type CallRow, type Tx, timelineEvent } from '@knoqra/db';

/** `m:ss`, as the web formats call durations. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const OUTBOUND_UNCONNECTED: Partial<Record<CallState, string>> = {
  busy: 'Busy',
  no_answer: 'No answer',
  failed: 'Call failed',
  canceled: 'Canceled call',
};

/** The contact timeline title for a call that just ended. */
export function endedCallTitle(input: {
  direction: CallRow['direction'];
  state: CallState;
  answered: boolean;
  billableSeconds: number;
}): string {
  const { direction, state, answered, billableSeconds } = input;
  if (state === 'completed') {
    const label = direction === 'inbound' ? 'Inbound call' : 'Outbound call';
    return `${label} · ${formatDuration(billableSeconds)}`;
  }
  if (direction === 'inbound') {
    return answered && state === 'failed' ? 'Call failed' : 'Missed call';
  }
  return OUTBOUND_UNCONNECTED[state] ?? 'Call failed';
}

export function voicemailTitle(durationSeconds: number): string {
  return `Voicemail · ${formatDuration(durationSeconds)}`;
}

/** A provider-sourced `call` timeline row for the call's contact. */
export async function insertCallTimeline(
  tx: Tx,
  row: CallRow,
  contactId: string,
  title: string,
  occurredAt: Date,
): Promise<void> {
  await tx.insert(timelineEvent).values({
    organizationId: row.organizationId,
    contactId,
    kind: 'call',
    title,
    source: 'provider',
    refType: 'call',
    refId: row.id,
    occurredAt,
  });
}
