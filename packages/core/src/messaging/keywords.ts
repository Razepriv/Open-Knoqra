const STOP = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'OPTOUT',
  'REVOKE',
]);
const START = new Set(['START', 'UNSTOP']);

/** Classifies an inbound body as a single-token opt-out or opt-in keyword. */
export function classifyKeyword(body: string): 'stop' | 'start' | null {
  const token = body
    .trim()
    .replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/g, '')
    .toUpperCase();
  if (STOP.has(token)) return 'stop';
  if (START.has(token)) return 'start';
  return null;
}
