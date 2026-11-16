import {
  SkeletonButton,
  SkeletonField,
  SkeletonPanel,
  SkeletonStatus,
  SkeletonText,
} from '@knoqra/ui';
import { SettingsSection } from '../settings/section';
import { SYSTEM_STATUS_SECTION, SystemStatusSkeleton } from '../settings/system-status-skeleton';
import { VoiceBodyBlocks } from '../settings/voice-skeleton';

/** Each body is exactly what its SettingsSection holds once loaded, so the page does not move. */

/** Name, account email (with hint), time zone (with hint) and Save profile. */
export function ProfileBodySkeleton({ label }: { label?: string }) {
  return (
    <div className="flex flex-col gap-5">
      {label ? <SkeletonStatus label={label} /> : null}
      <SkeletonField />
      <SkeletonField hint />
      <span aria-hidden="true" className="flex flex-col">
        <SkeletonField />
        <SkeletonText size="mono" widths={['55%']} lineHeight={15.125} className="mt-2" />
      </span>
      <SkeletonButton width={142} height={44} />
    </div>
  );
}

const themePills = [74, 70, 82] as const;

/** One checkbox with its label and hint (CheckboxField). */
function CheckboxSkeleton({ seed, hint = ['72%'] }: { seed: number; hint?: readonly string[] }) {
  return (
    <span aria-hidden="true" className="flex items-start gap-3">
      <span className="mt-[3px] size-[18px] shrink-0 rounded-[5px] border border-[color:var(--pillBorder)] bg-[color:var(--cell)]" />
      <span className="flex flex-1 flex-col gap-1">
        <SkeletonText widths={['38%']} lineHeight={19.25} seed={seed} />
        <SkeletonText lines={hint.length} widths={[...hint]} lineHeight={17.875} seed={seed + 1} />
      </span>
    </span>
  );
}

/** Theme pills, the two notification checkboxes and the usage-data consent (longer hint). */
export function PreferencesBodySkeleton({ label }: { label?: string }) {
  return (
    <>
      {label ? <SkeletonStatus label={label} /> : null}
      <span aria-hidden="true" className="flex flex-col">
        <SkeletonText widths={['3rem']} lineHeight={19.5} className="mb-3" />
        <span className="flex flex-wrap gap-2">
          {themePills.map((w) => (
            <SkeletonButton key={w} width={w} />
          ))}
        </span>
      </span>
      <span className="flex flex-col gap-5">
        <CheckboxSkeleton seed={1} />
        <CheckboxSkeleton seed={3} />
        <CheckboxSkeleton seed={5} hint={['94%', '56%']} />
      </span>
    </>
  );
}

/** The two-factor state line, the password field and the action button. */
export function SecurityBodySkeleton({ label }: { label?: string }) {
  return (
    <div className="flex flex-col gap-5">
      {label ? <SkeletonStatus label={label} /> : null}
      <span aria-hidden="true" className="flex items-center gap-3">
        <span className="size-[22px] shrink-0 rounded-full border border-[color:var(--muted)] opacity-40" />
        <span className="flex flex-1 flex-col gap-1">
          <SkeletonText widths={['42%']} lineHeight={15} />
          <SkeletonText widths={['70%']} lineHeight={17.875} />
        </span>
      </span>
      <span className="flex max-w-[400px] flex-col gap-4">
        <SkeletonField />
        <SkeletonButton width={160} />
      </span>
    </div>
  );
}

/** Signed-in devices as SessionItem draws them. */
export function SessionsBodySkeleton({ label, rows = 1 }: { label?: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {label ? <SkeletonStatus label={label} /> : null}
      {Array.from({ length: rows }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
          key={i}
          aria-hidden="true"
          className="flex items-center gap-3 rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 py-3 [box-shadow:var(--cellShadow)]"
        >
          <span className="size-5 shrink-0 rounded-[5px] border border-[color:var(--muted)] opacity-40" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            {/* 17px: the current device's name line carries its badge. */}
            <SkeletonText widths={['46%']} lineHeight={17} seed={i} />
            <SkeletonText size="mono" widths={['38%']} lineHeight={15.125} seed={i + 2} />
          </span>
        </span>
      ))}
    </div>
  );
}

/** A SettingsSection's own title and description, for the page-level outline. */
function SectionOutline({
  children,
  lines,
  part,
}: {
  children: React.ReactNode;
  lines: number;
  part: string;
}) {
  return (
    <SkeletonPanel data-skeleton-part={part} className="p-6 sm:p-8">
      <span className="flex flex-col gap-6">
        <span className="flex flex-col gap-2">
          <SkeletonText widths={['8rem']} lineHeight={26} />
          <SkeletonText lines={lines} widths={['28rem', 'min(70%, 16rem)']} lineHeight={22.75} />
        </span>
        {children}
      </span>
    </SkeletonPanel>
  );
}

/**
 * The place of the owner-only System status section while the account (and so the role) is still
 * loading: its real heading and its own loading body, hidden from assistive tech, as tall as the
 * section is when it first mounts. Most accounts that open Settings are the workspace owner, so
 * holding the space keeps the page still for them; for others it closes when the role arrives.
 */
export function SystemStatusPlaceholder() {
  return (
    <div aria-hidden="true" data-skeleton-part="system-status">
      <SettingsSection {...SYSTEM_STATUS_SECTION} id="system-status-placeholder">
        <SystemStatusSkeleton />
      </SettingsSection>
    </div>
  );
}

/**
 * Settings while it loads: the page header, the five sections in their two columns and the place
 * of the owner-only System status section.
 */
export function SettingsSkeleton() {
  return (
    <section data-skeleton="settings" className="flex flex-1 flex-col gap-4">
      <SkeletonStatus label="Loading your settings" />
      <SkeletonPanel
        data-skeleton-part="settings-header"
        className="flex flex-col gap-5 p-6 sm:p-9"
      >
        <SkeletonText widths={['9.5rem']} />
        <SkeletonText size="mono" widths={['4rem']} />
        <SkeletonText widths={['15rem']} lineHeight="clamp(35.28px, 4.9vw, 58.8px)" />
      </SkeletonPanel>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SectionOutline lines={2} part="profile">
            <ProfileBodySkeleton />
          </SectionOutline>
          <SectionOutline lines={1} part="preferences">
            <PreferencesBodySkeleton />
          </SectionOutline>
        </div>
        <div className="flex flex-col gap-4">
          <SectionOutline lines={2} part="security">
            <SecurityBodySkeleton />
          </SectionOutline>
          <SectionOutline lines={2} part="sessions">
            <SessionsBodySkeleton />
          </SectionOutline>
          <SectionOutline lines={2} part="voice">
            <div aria-hidden="true" className="flex flex-col gap-5">
              <VoiceBodyBlocks />
            </div>
          </SectionOutline>
        </div>
      </div>
      <SystemStatusPlaceholder />
    </section>
  );
}
