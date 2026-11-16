import { useCallback, useEffect, useRef, useState } from 'react';

/** A focus block is 25 minutes. */
export const FOCUS_SECONDS = 1500;
/** Where the end of the running block is kept, so it survives a reload or a second tab. */
export const FOCUS_STORAGE_KEY = 'knoqra.focus.endsAt';

const TICK_MS = 1000;
/** A block that ran out longer ago than this, while the page was closed, ends without a word. */
export const FOCUS_STALE_MS = 60_000;

/** Whole seconds left until `endsAt` (rounded up, so a fresh block reads 25:00); 0 when done. */
export function focusRemaining(endsAt: number | null, now: number): number {
  if (endsAt === null) return 0;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

/** "25:00", "04:07". Negative values read as 00:00. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
}

/** A stored end time, or null for anything that is not a positive finite number of ms. */
export function parseStoredEndsAt(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The block to pick up when the page opens: the stored end time, or null when there is none or it
 * ran out more than a minute ago (nobody wants "Focus block done" for yesterday's block).
 */
export function restoreEndsAt(raw: string | null, now: number): number | null {
  const endsAt = parseStoredEndsAt(raw);
  if (endsAt === null || now - endsAt > FOCUS_STALE_MS) return null;
  return endsAt;
}

// Storage can be missing or throw (private windows, blocked site data); the timer still works.
function readStored(): string | null {
  try {
    return window.localStorage.getItem(FOCUS_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The block to resume on mount; a stale one is removed from storage on the way. */
function initialEndsAt(): number | null {
  const raw = readStored();
  const endsAt = restoreEndsAt(raw, Date.now());
  if (raw !== null && endsAt === null) writeEndsAt(null);
  return endsAt;
}

function writeEndsAt(endsAt: number | null): void {
  try {
    if (endsAt === null) window.localStorage.removeItem(FOCUS_STORAGE_KEY);
    else window.localStorage.setItem(FOCUS_STORAGE_KEY, String(endsAt));
  } catch {
    // Without storage the block simply does not survive a reload.
  }
}

export interface FocusTimer {
  running: boolean;
  /** Seconds left in the running block, 0 when none is running. */
  remaining: number;
  start: () => void;
  stop: () => void;
}

/**
 * A 25-minute focus block. The end time lives in localStorage, so a reload keeps counting and
 * another tab follows along. `onDone` fires once per block, when it runs out (not when stopped).
 */
export function useFocusTimer({ onDone }: { onDone?: () => void } = {}): FocusTimer {
  const [endsAt, setEndsAt] = useState<number | null>(initialEndsAt);
  const [now, setNow] = useState(() => Date.now());
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const finished = useRef<number | null>(null);

  useEffect(() => {
    if (endsAt === null) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [endsAt]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== FOCUS_STORAGE_KEY) return;
      setNow(Date.now());
      setEndsAt(parseStoredEndsAt(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const remaining = focusRemaining(endsAt, now);

  useEffect(() => {
    if (endsAt === null || remaining > 0) return;
    setEndsAt(null);
    writeEndsAt(null);
    if (finished.current === endsAt) return;
    finished.current = endsAt;
    onDoneRef.current?.();
  }, [endsAt, remaining]);

  const start = useCallback(() => {
    const at = Date.now();
    const end = at + FOCUS_SECONDS * 1000;
    setNow(at);
    setEndsAt(end);
    writeEndsAt(end);
  }, []);

  const stop = useCallback(() => {
    setEndsAt(null);
    writeEndsAt(null);
  }, []);

  return { running: endsAt !== null && remaining > 0, remaining, start, stop };
}
