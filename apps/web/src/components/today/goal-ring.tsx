const SIZE = 136;
const RADIUS = 56;
const STROKE = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface GoalRingProps {
  done: number;
  target: number;
}

/** Today's logged outcomes against the daily goal, drawn as a ring that fills clockwise. */
export function GoalRing({ done, target }: GoalRingProps) {
  const progress = target > 0 ? Math.min(1, done / target) : 0;
  return (
    <div
      role="img"
      aria-label={`${done} of ${target} outcomes today`}
      className="relative shrink-0"
      style={{ width: SIZE, height: SIZE }}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden="true"
        className="block -rotate-90"
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          style={{ stroke: 'var(--ring-track)' }}
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
          opacity={progress === 0 ? 0 : 1}
          className="transition-[stroke-dashoffset,stroke] duration-700 ease-[cubic-bezier(.2,0,0,1)]"
          style={{ stroke: 'var(--ring-fill)' }}
        />
      </svg>
      <div
        aria-hidden="true"
        className="absolute inset-0 flex flex-col items-center justify-center gap-1"
      >
        <span className="font-[family-name:var(--font-display)] font-medium text-[34px] tabular-nums leading-none tracking-[-0.03em]">
          {done}/{target}
        </span>
        <span className="font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] leading-none">
          KEPT
        </span>
      </div>
    </div>
  );
}
