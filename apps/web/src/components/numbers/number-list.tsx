import { Button, Panel } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { RefreshCw, ShoppingBag } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { formatPhone } from '../../lib/contacts';
import {
  type AssignedUse,
  activeCapabilities,
  type PhoneNumber,
  useAssignNumber,
  useSyncNumbers,
} from '../../lib/numbers';
import { focusRing } from '../../lib/ui-classes';
import { FormAlert } from '../form-alert';
import { ScrollRegion } from '../scroll-region';
import { sectionHeading } from '../usage/usage-layout';
import { NumberSearch } from './number-search';
import { NUMBER_HEADERS as HEADERS } from './numbers-skeletons';

const TEN_DLC: Record<PhoneNumber['tenDlcStatus'], string> = {
  registered: 'Registered',
  pending: 'Pending',
  none: 'Not registered',
  failed: 'Failed',
  not_required: 'Not required',
};
const WHATSAPP: Record<PhoneNumber['whatsappStatus'], string> = {
  none: 'Not set up',
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};
const STATUS: Record<PhoneNumber['status'], string> = {
  active: 'Active',
  pending: 'Pending',
  inactive: 'Inactive',
};
const USES: { value: AssignedUse; label: string }[] = [
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'calls', label: 'Calls' },
  { value: 'messages', label: 'Messages' },
  { value: 'calls_and_messages', label: 'Calls and messages' },
];

const CELL = 'bg-[color:var(--cell)] px-3 py-3 text-[14px]';
const chip =
  'inline-flex h-7 items-center whitespace-nowrap rounded-[14px] bg-[color:var(--cell)] px-[10px] font-[family-name:var(--font-mono)] font-medium text-[11px] leading-none';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function SyncError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'voice_not_configured') {
    return (
      <p role="alert" className="text-[14px] text-[color:var(--danger-text)] leading-snug">
        Connect Telnyx before syncing numbers.{' '}
        <Link
          to="/setup"
          search={{ step: 'connect' }}
          className="text-[color:var(--text)] underline underline-offset-4"
        >
          Connect Telnyx
        </Link>
      </p>
    );
  }
  return <FormAlert message={errorMessage(error, 'Could not sync your numbers from Telnyx.')} />;
}

function AssignedUseCell({
  number,
  canManage,
  onChange,
  busy,
}: {
  number: PhoneNumber;
  canManage: boolean;
  onChange: (use: AssignedUse) => void;
  busy: boolean;
}) {
  const label = USES.find((use) => use.value === number.assignedUse)?.label ?? '';
  if (!canManage) return <span className="text-[14px]">{label}</span>;
  return (
    <select
      aria-label={`Assigned use for ${formatPhone(number.e164)}`}
      value={number.assignedUse}
      disabled={busy}
      onChange={(event) => onChange(event.target.value as AssignedUse)}
      className={`h-10 w-full cursor-pointer rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-3 text-[14px] text-[color:var(--text)] ${focusRing}`}
    >
      {USES.map((use) => (
        <option key={use.value} value={use.value}>
          {use.label}
        </option>
      ))}
    </select>
  );
}

function EmptyNumbers({ canManage, connected }: { canManage: boolean; connected: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="max-w-[56ch] text-[14px] text-[color:var(--muted)] leading-relaxed">
        No numbers yet. Sync them from Telnyx, or connect Telnyx first.
      </p>
      {!connected && canManage ? (
        <Link
          to="/setup"
          search={{ step: 'connect' }}
          className={`font-medium text-[14px] underline underline-offset-4 ${focusRing}`}
        >
          Connect Telnyx
        </Link>
      ) : null}
    </div>
  );
}

export interface NumberListProps {
  numbers: readonly PhoneNumber[];
  canManage: boolean;
  /** Whether the credential check passes, which decides the empty state's action. */
  connected: boolean;
  /** Only the workspace owner can buy numbers. */
  canBuy?: boolean;
}

export function NumberList({ numbers, canManage, connected, canBuy = false }: NumberListProps) {
  const [buying, setBuying] = useState(false);
  const sync = useSyncNumbers();
  const assign = useAssignNumber();
  return (
    <section aria-labelledby="numbers-heading">
      <Panel className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
          <h2 id="numbers-heading" className={sectionHeading}>
            Numbers
          </h2>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              {canBuy ? (
                <Button
                  id="buy-number-button"
                  variant="primary"
                  aria-expanded={buying}
                  aria-controls="buy-number-panel"
                  onClick={() => setBuying((open) => !open)}
                >
                  <ShoppingBag size={15} strokeWidth={1.75} aria-hidden="true" />
                  Buy a number
                </Button>
              ) : (
                <p className="text-[13px] text-[color:var(--muted)]">
                  Only the workspace owner can buy numbers.
                </p>
              )}
              <Button
                variant="ghost"
                onClick={() => sync.mutate()}
                disabled={sync.isPending}
                aria-busy={sync.isPending}
              >
                <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />
                {sync.isPending ? 'Syncing…' : 'Sync numbers'}
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-[color:var(--muted)]">
              Ask an owner or admin to sync or assign numbers.
            </p>
          )}
        </div>
        {canBuy && buying ? (
          <div
            id="buy-number-panel"
            className="flex flex-col gap-4 rounded-[22px] border border-[color:var(--panelBorder)] p-4"
          >
            <h3 className="font-medium text-[15px]">Buy a number</h3>
            <NumberSearch
              idPrefix="numbers-buy"
              fallbackFocusId="buy-number-button"
              onBought={() => setBuying(false)}
            />
          </div>
        ) : null}
        {sync.isError ? <SyncError error={sync.error} /> : null}
        {assign.isError ? (
          <FormAlert message={errorMessage(assign.error, 'Could not assign this number.')} />
        ) : null}
        {numbers.length === 0 ? (
          <EmptyNumbers canManage={canManage} connected={connected} />
        ) : (
          <ScrollRegion label="Numbers">
            <table className="w-full min-w-[820px] border-separate border-spacing-y-2 text-left">
              <thead>
                <tr>
                  {HEADERS.map((header) => (
                    <th
                      key={header}
                      scope="col"
                      className="px-3 pb-1 font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em]"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {numbers.map((number) => (
                  <tr key={number.id}>
                    <td
                      className={`${CELL} rounded-l-[20px] font-[family-name:var(--font-mono)] font-medium`}
                    >
                      {formatPhone(number.e164)}
                    </td>
                    <td className={CELL}>
                      <span className="flex flex-wrap gap-[6px]">
                        {activeCapabilities(number).map((label) => (
                          <span key={label} className={chip}>
                            {label}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className={CELL}>{STATUS[number.status]}</td>
                    <td className={CELL}>{TEN_DLC[number.tenDlcStatus]}</td>
                    <td className={CELL}>{WHATSAPP[number.whatsappStatus]}</td>
                    <td className={`${CELL} rounded-r-[20px]`}>
                      <AssignedUseCell
                        number={number}
                        canManage={canManage}
                        busy={assign.isPending && assign.variables?.id === number.id}
                        onChange={(assignedUse) => assign.mutate({ id: number.id, assignedUse })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </Panel>
    </section>
  );
}
