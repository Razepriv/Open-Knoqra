import { Panel, Reveal } from '@knoqra/ui';
import { useState } from 'react';
import { deskSlot } from '../../extensions';
import { formatMicros } from '../../lib/money';
import {
  CHANNEL_LABELS,
  channelTotals,
  dayTotal,
  USAGE_CHANNELS,
  type UsageChannel,
  type UsageSummary,
  useUsageSummary,
} from '../../lib/usage';
import { CHART_HOVER_LINE, CHART_PLOT_BOX, SpendChartSkeleton } from './usage-layout';
import { BlockError, eyebrow, sectionHeading } from './usage-states';

/**
 * Channel colours come from the design tokens; the palette has no categorical hues of its own, so
 * identity never rests on colour alone: the legend names every channel with its total, and the
 * hidden table carries the same numbers.
 */
const CHANNEL_COLOR: Record<UsageChannel, string> = {
  voice: 'var(--line)',
  sms: 'var(--dot-ok)',
  whatsapp: 'var(--dot-warn)',
  other: 'var(--dot-none)',
};

const WIDTH = 640;
const HEIGHT = 220;
const MARGIN = { top: 12, right: 8, bottom: 26, left: 52 } as const;
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;
const SEGMENT_GAP = 2;
const MAX_ROUNDING = 4;

const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const dayLabel = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));

/** The screen-reader summary of the whole chart. */
export function chartLabel(summary: UsageSummary): string {
  const parts = channelTotals(summary.totals).map(
    ({ channel, micros }) => `${CHANNEL_LABELS[channel]} ${formatMicros(micros)}`,
  );
  const total = channelTotals(summary.totals).reduce((sum, { micros }) => sum + micros, 0);
  return `Daily spend by channel, ${dayLabel(summary.from)} to ${dayLabel(summary.to)}. ${parts.join(', ')}. Total ${formatMicros(total)}.`;
}

interface Bar {
  date: string;
  x: number;
  width: number;
  segments: { channel: UsageChannel; y: number; height: number }[];
}

function layoutBars(days: UsageSummary['days'], max: number): Bar[] {
  const slot = PLOT_W / Math.max(days.length, 1);
  const width = Math.max(1, slot - Math.min(2, slot * 0.25));
  return days.map((day, index) => {
    let top = MARGIN.top + PLOT_H;
    const segments: Bar['segments'] = [];
    for (const channel of USAGE_CHANNELS) {
      const height = max === 0 ? 0 : (day[channel] / max) * PLOT_H;
      if (height <= 0) continue;
      const drawn = Math.max(1, height - (segments.length > 0 ? SEGMENT_GAP : 0));
      top -= height;
      segments.push({ channel, y: top + (height - drawn), height: drawn });
    }
    return { date: day.date, x: MARGIN.left + index * slot + (slot - width) / 2, width, segments };
  });
}

function Legend({ totals }: { totals: UsageSummary['totals'] }) {
  return (
    <ul aria-label="Channels" className="flex flex-wrap gap-x-5 gap-y-2">
      {channelTotals(totals).map(({ channel, micros }) => (
        <li key={channel} className="flex items-center gap-2 text-[13px]">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-[3px]"
            style={{ background: CHANNEL_COLOR[channel] }}
          />
          <span>{CHANNEL_LABELS[channel]}</span>
          <span className="font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]">
            {formatMicros(micros)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Extra lines an edition adds under the legend (extensions.ts), for example a fee it charges. */
function SpendNotes({ summary }: { summary: UsageSummary }) {
  const Notes = deskSlot('SpendNotes');
  return Notes ? <Notes summary={summary} /> : null;
}

function ChartTable({ summary }: { summary: UsageSummary }) {
  return (
    <table className="sr-only">
      <caption>Daily spend by channel</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          {USAGE_CHANNELS.map((channel) => (
            <th key={channel} scope="col">
              {CHANNEL_LABELS[channel]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {summary.days.map((day) => (
          <tr key={day.date}>
            <th scope="row">{day.date}</th>
            {USAGE_CHANNELS.map((channel) => (
              <td key={channel}>{formatMicros(day[channel])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Plot({ summary }: { summary: UsageSummary }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const max = Math.max(0, ...summary.days.map(dayTotal));
  const bars = layoutBars(summary.days, max);
  const ticks = [0, max / 2, max];
  const hoveredDay = summary.days.find((day) => day.date === hovered);
  const last = summary.days.length - 1;
  const xLabels = [...new Set([0, Math.floor(last / 2), last])].map((index) => ({
    index,
    date: summary.days[index]?.date ?? '',
  }));
  const slot = PLOT_W / Math.max(summary.days.length, 1);
  return (
    <div className="flex flex-col gap-2">
      <p
        aria-hidden="true"
        className={`${CHART_HOVER_LINE} font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]`}
      >
        {hoveredDay
          ? `${dayLabel(hoveredDay.date)}: ${channelTotals({ ...summary.totals, ...hoveredDay })
              .filter(({ micros }) => micros > 0)
              .map(({ channel, micros }) => `${CHANNEL_LABELS[channel]} ${formatMicros(micros)}`)
              .join(', ')} · Total ${formatMicros(dayTotal(hoveredDay))}`
          : ''}
      </p>
      <svg
        role="img"
        aria-label={chartLabel(summary)}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className={`${CHART_PLOT_BOX} h-auto`}
        onMouseLeave={() => setHovered(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - box.left) / box.width) * WIDTH - MARGIN.left;
          const index = Math.floor(x / slot);
          setHovered(summary.days[index]?.date ?? null);
        }}
      >
        {ticks.map((tick) => {
          const y = MARGIN.top + PLOT_H - (max === 0 ? 0 : (tick / max) * PLOT_H);
          return (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={WIDTH - MARGIN.right}
                y1={y}
                y2={y}
                stroke="var(--panelBorder)"
                strokeWidth={1}
              />
              <text
                x={MARGIN.left - 8}
                y={y + 4}
                textAnchor="end"
                fontSize={11}
                fill="var(--muted)"
                fontFamily="var(--font-mono)"
              >
                {formatMicros(Math.round(tick))}
              </text>
            </g>
          );
        })}
        {bars.map((bar) => (
          <g key={bar.date}>
            {bar.segments.map((segment, index) => (
              <rect
                key={segment.channel}
                x={bar.x}
                y={segment.y}
                width={bar.width}
                height={segment.height}
                rx={index === bar.segments.length - 1 ? Math.min(MAX_ROUNDING, bar.width / 2) : 0}
                fill={CHANNEL_COLOR[segment.channel]}
                pointerEvents="none"
              />
            ))}
          </g>
        ))}
        {xLabels.map(({ index, date }) => (
          <text
            key={date}
            x={MARGIN.left + index * slot + slot / 2}
            y={HEIGHT - 6}
            textAnchor={index === 0 ? 'start' : index === last ? 'end' : 'middle'}
            fontSize={11}
            fill="var(--muted)"
            fontFamily="var(--font-mono)"
          >
            {dayLabel(date)}
          </text>
        ))}
      </svg>
    </div>
  );
}

export interface SpendChartProps {
  from: string;
  to: string;
  /** False while the range in the filters is invalid, so no request is made for it. */
  enabled: boolean;
}

/** Row 2: stacked daily spend bars by channel, with the same numbers in a hidden table. */
export function SpendChart({ from, to, enabled }: SpendChartProps) {
  const summary = useUsageSummary({ from, to }, enabled);
  const empty =
    summary.data !== undefined && channelTotals(summary.data.totals).every((t) => t.micros === 0);
  return (
    <Panel aria-label="Spend" className="flex flex-col gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={sectionHeading}>Spend by day</h2>
        <span className={eyebrow}>{`${from} to ${to} · UTC`}</span>
      </div>
      {summary.isError && !summary.data ? (
        <BlockError
          what="your spend"
          error={summary.error}
          onRetry={() => void summary.refetch()}
          retrying={summary.isFetching}
        />
      ) : (
        <Reveal loading={summary.isPending && enabled}>
          {summary.data ? (
            <div className="flex flex-col gap-4">
              {empty ? (
                // The plot's footprint, so a new workspace's panels sit where a chart's would.
                <div className="flex flex-col gap-2">
                  <div className={CHART_HOVER_LINE} />
                  <div className={`${CHART_PLOT_BOX} flex items-center justify-center`}>
                    <p className="max-w-[46ch] text-center text-[15px] text-[color:var(--muted)]">
                      No spend in this range. Charges from calls and messages show up here as they
                      happen.
                    </p>
                  </div>
                </div>
              ) : (
                <Plot summary={summary.data} />
              )}
              <Legend totals={summary.data.totals} />
              <SpendNotes summary={summary.data} />
              <ChartTable summary={summary.data} />
            </div>
          ) : enabled ? (
            <SpendChartSkeleton />
          ) : (
            <p className="text-[15px] text-[color:var(--muted)]">
              Fix the dates above to see your spend.
            </p>
          )}
        </Reveal>
      )}
    </Panel>
  );
}
