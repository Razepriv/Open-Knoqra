import { Button, Panel } from '@knoqra/ui';
import type { ImportProgress } from '../../lib/import-runner';
import { formatCount, StepHeading } from './parts';

export interface RunStepProps {
  progress: ImportProgress;
  cancelling: boolean;
  onCancel: () => void;
}

export function RunStep({ progress, cancelling, onCancel }: RunStepProps) {
  const { processed, total, batch, batches } = progress;
  const percent = total === 0 ? 0 : Math.round((processed / total) * 100);
  const valueText = `${formatCount(processed)} of ${formatCount(total)} rows`;
  const current = Math.min(batch + 1, batches);

  return (
    <Panel className="flex flex-col gap-6 p-6 sm:p-9">
      <StepHeading eyebrow="Step 4 of 5 · Import" title="Importing contacts">
        <p>Keep this tab open. Rows are sent in batches of 500.</p>
      </StepHeading>

      <div className="flex flex-col gap-3">
        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={processed}
          aria-valuetext={valueText}
          className="h-3 overflow-hidden rounded-full border border-[color:var(--panelBorder)] bg-[color:var(--cell)] [box-shadow:var(--cellShadow)]"
        >
          <div
            className="h-full rounded-full bg-[color:var(--line)] transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p
          role="status"
          className="font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]"
        >
          {valueText} · batch {current} of {batches}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={onCancel} aria-disabled={cancelling}>
          Cancel import
        </Button>
        <p aria-live="polite" className="text-[13px] text-[color:var(--muted)]">
          {cancelling
            ? 'Cancelling once this batch finishes. Rows already imported stay imported.'
            : ''}
        </p>
      </div>
    </Panel>
  );
}
