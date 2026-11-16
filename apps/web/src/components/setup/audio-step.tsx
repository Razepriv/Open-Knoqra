import { Button } from '@knoqra/ui';
import { MicOff, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Setup, useUpdateSetup } from '../../lib/setup';
import { FormAlert } from '../form-alert';

const TONE_HZ = 440;
const TONE_MS = 1000;
const TONE_GAIN = 0.15;
const card = 'flex flex-col gap-4 rounded-[22px] bg-[color:var(--cell)] p-5';
const cardTitle = 'font-semibold text-[15px] leading-[1.3]';

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  const scoped = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scoped.AudioContext ?? scoped.webkitAudioContext;
}

type MicStatus = 'idle' | 'starting' | 'listening' | 'blocked' | 'unavailable';

/** Owns the microphone stream and the level meter; everything is stopped on unmount. */
function useMicMeter() {
  const [status, setStatus] = useState<MicStatus>('idle');
  const [level, setLevel] = useState(0);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef<number | null>(null);
  const alive = useRef(true);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    void context.current?.close().catch(() => undefined);
    context.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
    };
  }, [stop]);

  const start = useCallback(async () => {
    stop();
    setStatus('starting');
    const Ctor = audioContextCtor();
    if (!navigator.mediaDevices?.getUserMedia || !Ctor) {
      setStatus('unavailable');
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (!alive.current) return;
      const name = error instanceof DOMException ? error.name : '';
      setStatus(
        name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable' : 'blocked',
      );
      return;
    }
    if (!alive.current) {
      for (const track of media.getTracks()) track.stop();
      return;
    }
    const ctx = new Ctor();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(media).connect(analyser);
    stream.current = media;
    context.current = ctx;
    const samples = new Float32Array(analyser.fftSize);
    let last = -1;
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      const next = Math.min(100, Math.round(rms * 400));
      if (next !== last) {
        last = next;
        setLevel(next);
      }
      frame.current = requestAnimationFrame(tick);
    };
    setStatus('listening');
    tick();
  }, [stop]);

  return { status, level, start };
}

function MicCard() {
  const mic = useMicMeter();
  const blocked = mic.status === 'blocked';
  return (
    <section aria-label="Microphone" className={card}>
      <h3 className={cardTitle}>Microphone</h3>
      {blocked ? (
        <div className="flex flex-col items-start gap-3">
          <p className="flex items-start gap-2 text-[14px] leading-snug">
            <MicOff size={16} strokeWidth={1.75} aria-hidden="true" className="mt-[2px] shrink-0" />
            Microphone blocked. Allow microphone access for this site, then try again.
          </p>
          <Button variant="primary" onClick={() => void mic.start()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <p className="text-[13px] text-[color:var(--muted)] leading-snug">
            {mic.status === 'listening'
              ? 'Say something. The bar should move.'
              : 'Check that your browser can hear you.'}
          </p>
          {mic.status === 'unavailable' ? (
            <p role="alert" className="text-[13px] text-[color:var(--danger-text)]">
              No working microphone was found. Connect one and try again.
            </p>
          ) : null}
          {mic.status === 'listening' ? (
            // biome-ignore lint/a11y/useSemanticElements: a styled bar with an explicit meter role and aria-valuenow, as the setup spec asks
            <div
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={mic.level}
              className="h-3 w-full overflow-hidden rounded-full bg-[color:var(--pill)]"
            >
              <div
                aria-hidden="true"
                className="h-full rounded-full bg-[color:var(--accent)]"
                style={{ width: `${mic.level}%` }}
              />
            </div>
          ) : null}
          <Button
            variant="ghost"
            className="self-start"
            aria-busy={mic.status === 'starting'}
            disabled={mic.status === 'starting'}
            onClick={() => void mic.start()}
          >
            {mic.status === 'listening' ? 'Restart microphone' : 'Test microphone'}
          </Button>
        </>
      )}
    </section>
  );
}

type ToneStatus = 'idle' | 'playing' | 'asking' | 'heard' | 'not_heard';

/** Plays a one-second 440 Hz tone, then asks whether it was heard. */
function ToneCard({ done }: { done: boolean }) {
  const update = useUpdateSetup();
  const [status, setStatus] = useState<ToneStatus>('idle');
  const context = useRef<AudioContext | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void context.current?.close().catch(() => undefined);
      context.current = null;
    },
    [],
  );

  const play = () => {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    void context.current?.close().catch(() => undefined);
    const ctx = new Ctor();
    context.current = ctx;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = TONE_HZ;
    gain.gain.value = TONE_GAIN;
    oscillator.connect(gain).connect(ctx.destination);
    void ctx.resume();
    oscillator.start();
    oscillator.stop(ctx.currentTime + TONE_MS / 1000);
    setStatus('playing');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('asking'), TONE_MS);
  };

  return (
    <section aria-label="Speaker" className={card}>
      <h3 className={cardTitle}>Speaker</h3>
      <p className="text-[13px] text-[color:var(--muted)] leading-snug">
        Turn your volume up a little, then play a short tone.
      </p>
      <Button variant="ghost" className="self-start" disabled={status === 'playing'} onClick={play}>
        <Volume2 size={15} strokeWidth={1.75} aria-hidden="true" />
        {status === 'playing' ? 'Playing…' : 'Play test tone'}
      </Button>
      {status === 'asking' ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="font-medium text-[14px]">Did you hear the tone?</legend>
          <div className="flex gap-2">
            <Button
              variant="primary"
              aria-busy={update.isPending}
              disabled={update.isPending}
              onClick={() =>
                update.mutate({ audioChecked: true }, { onSuccess: () => setStatus('heard') })
              }
            >
              Yes
            </Button>
            <Button variant="ghost" onClick={() => setStatus('not_heard')}>
              No
            </Button>
          </div>
          {update.isError ? <FormAlert message="Could not save your audio check." /> : null}
        </fieldset>
      ) : null}
      {status === 'heard' || (done && status === 'idle') ? (
        <p role="status" className="font-medium text-[14px]">
          Audio checked.
        </p>
      ) : null}
      {status === 'not_heard' ? (
        <div className="flex flex-col gap-2 text-[13px] leading-snug">
          <p className="font-medium text-[14px]">Try these, then play the tone again.</p>
          <ul className="list-disc pl-5 text-[color:var(--muted)]">
            <li>Raise the volume on your device and in the browser tab.</li>
            <li>Check that the right speakers or headphones are selected.</li>
            <li>Unplug and replug your headphones, or try another output.</li>
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Step 3: check the microphone and the speaker before the first call. */
export function AudioStep({ setup, onDone }: { setup: Setup; onDone: () => void }) {
  const done = setup.steps.find((step) => step.id === 'audio')?.done ?? false;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        <MicCard />
        <ToneCard done={done} />
      </div>
      {done ? (
        <Button variant="primary" className="self-start" onClick={onDone}>
          Continue
        </Button>
      ) : null}
    </div>
  );
}
