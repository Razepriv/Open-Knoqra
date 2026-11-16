import {
  SkeletonAvatar,
  SkeletonButton,
  SkeletonPanel,
  SkeletonStatus,
  SkeletonText,
} from '@knoqra/ui';
import { CHANNEL_ORDER } from '../../lib/contact360-channels';
import { contact360Layout, profileHeaderLayout } from '../../lib/contacts-layout';
import { ContactListOutline } from './contacts-skeleton';

/**
 * The chips under the name, as wide as a contact with every detail draws them: phone, email and
 * local time (mono), then two tags. They wrap where the real ones do.
 */
const chipWidths = [134, 169, 275] as const;
const tagWidths = [76, 46] as const;
/** Call, WhatsApp, SMS: the header's channel pills, top to bottom. */
const CHANNEL_PILL_HEIGHTS = [40, 38, 38] as const;

/** ProfileHeader's outline: 84px avatar, name, subtitle, contact chips, more button, channel pills. */
function ProfileHeaderSkeleton() {
  return (
    <SkeletonPanel data-skeleton-part="profile-header" className={profileHeaderLayout.panel}>
      <SkeletonAvatar size={84} />
      <span className={profileHeaderLayout.main}>
        <span className={profileHeaderLayout.titleRow}>
          <SkeletonText
            widths={['15rem']}
            lineHeight="clamp(26px, 3vw, 34px)"
            className="min-w-0 flex-1"
          />
          <SkeletonButton size="icon" height={40} className="self-start" />
        </span>
        <SkeletonText widths={['14rem']} lineHeight={18.2} />
        <span className={profileHeaderLayout.chips}>
          {chipWidths.map((w) => (
            <span
              key={w}
              className="flex h-7 items-center rounded-[14px] bg-[color:var(--cell)] px-[10px]"
              style={{ width: w }}
            >
              <SkeletonText size="mono" widths={[100]} className="flex-1" />
            </span>
          ))}
          {tagWidths.map((w) => (
            <span
              key={w}
              className="flex h-7 items-center rounded-[14px] border border-[color:var(--muted)] px-[10px] opacity-60"
              style={{ width: w }}
            >
              <SkeletonText widths={[100]} lineHeight={18} className="flex-1" />
            </span>
          ))}
        </span>
      </span>
      <span data-skeleton-part="profile-actions" className={profileHeaderLayout.actions}>
        {CHANNEL_PILL_HEIGHTS.map((height, i) => (
          <SkeletonButton
            // biome-ignore lint/suspicious/noArrayIndexKey: Call, WhatsApp, SMS in a fixed order
            key={i}
            width={profileHeaderLayout.actionMinWidth}
            height={height}
          />
        ))}
      </span>
    </SkeletonPanel>
  );
}

const entryShapes = [
  { label: 30, body: [86, 58] },
  { label: 0, body: [64] },
  { label: 22, body: [92, 40] },
] as const;

/** Timeline entries as TimelineEntry draws them: a 40px tile, the bubble, the time column. */
export function TimelineEntriesSkeleton({ label }: { label?: string }) {
  return (
    <div className="flex flex-col gap-5">
      {label ? <SkeletonStatus label={label} /> : null}
      <span aria-hidden="true" className="flex flex-col gap-2">
        <SkeletonText size="mono" widths={['5.5rem']} lineHeight={15.75} />
        <span className="flex flex-col gap-2">
          {entryShapes.map((shape, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder entries
              key={i}
              className="grid grid-cols-[40px_minmax(0,1fr)] items-start gap-3 sm:grid-cols-[40px_minmax(0,1fr)_72px]"
            >
              <span className="size-10 rounded-[13px] bg-[color:var(--cell)]" />
              <span className="flex flex-col gap-1 rounded-[16px] bg-[color:var(--cell)] px-[14px] py-[10px]">
                <SkeletonText widths={[`${48 + shape.label}%`]} lineHeight={16.875} seed={i} />
                <SkeletonText
                  lines={shape.body.length}
                  widths={shape.body.map((w) => `${w}%`)}
                  lineHeight={18.85}
                  seed={i + 4}
                />
                <SkeletonText size="mono" widths={['34%']} lineHeight={15.75} seed={i + 8} />
              </span>
              <SkeletonText
                size="mono"
                widths={['3rem']}
                lineHeight={16.5}
                className="col-start-2 sm:col-start-3 sm:items-end sm:pt-3"
              />
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

/** All, Calls, Messages, Notes & consent: 32px pills with 11px padding. */
const filterPills = [40, 53, 78, 116] as const;

/** The Timeline panel: header with its filter pills, the note composer, then the entries. */
function TimelineOutline() {
  return (
    <SkeletonPanel
      data-skeleton-part="timeline"
      className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-[18px]"
    >
      <span className="flex flex-wrap items-center gap-2">
        <SkeletonText widths={['5.5rem']} lineHeight={18} />
        <span className="ml-1 hidden sm:block">
          <SkeletonText size="mono" widths={['11rem']} />
        </span>
        <span className="flex-1" />
        <span className="flex flex-wrap gap-[6px]">
          {filterPills.map((w) => (
            <SkeletonButton key={w} size="sm" width={w} />
          ))}
        </span>
      </span>
      <span className="flex flex-col gap-2">
        <span className="flex h-[71.5px] flex-col justify-center rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 py-3 [box-shadow:var(--cellShadow)]">
          <SkeletonText widths={['62%']} lineHeight={22.75} />
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <SkeletonText size="mono" widths={['10rem']} lineHeight={16.5} />
          <span className="flex-1" />
          <SkeletonButton width={104} />
        </span>
      </span>
      <TimelineEntriesSkeleton />
    </SkeletonPanel>
  );
}

/** Under a consent row's name: its one line of why (evidence and source open on request). */
export function ConsentRowSkeleton({ seed = 0 }: { seed?: number }) {
  return (
    <span aria-hidden="true" className="flex flex-col">
      <SkeletonText widths={[`${86 - seed * 8}%`]} lineHeight={16.2} seed={seed} />
    </span>
  );
}

/** The Permissions ribbon (consent, provenance) while the contact loads. */
export function ConsentRibbonSkeleton() {
  return (
    <SkeletonPanel className="flex flex-1 flex-col gap-4 overflow-auto p-[18px]">
      <span className="flex flex-col gap-3">
        <SkeletonText widths={['6.5rem']} lineHeight={18} />
        <SkeletonText lines={2} widths={[96, 70]} lineHeight={18.125} />
        <span className="flex flex-col gap-[6px]">
          {CHANNEL_ORDER.map((channel, i) => (
            <span
              key={channel}
              className="flex flex-col gap-1 rounded-[14px] bg-[color:var(--cell)] px-3 py-[10px]"
            >
              <span className="flex items-center justify-between gap-2">
                <SkeletonText widths={['5rem']} lineHeight={16} seed={i} />
                <SkeletonText size="mono" widths={['4.5rem']} lineHeight={16} seed={i + 2} />
              </span>
              <ConsentRowSkeleton seed={i % 3} />
            </span>
          ))}
        </span>
      </span>
      <span className="flex flex-col gap-1">
        <SkeletonText size="mono" lines={2} widths={['100%', '45%']} lineHeight={15.75} />
        <SkeletonText widths={['8rem']} lineHeight={26} />
      </span>
    </SkeletonPanel>
  );
}

/** The right-hand column of Contact 360: back link (narrow screens), header and timeline. */
export function ContactViewSkeleton({ label }: { label?: string }) {
  return (
    <div className={contact360Layout.view}>
      {label ? <SkeletonStatus label={label} /> : null}
      <span aria-hidden="true" className="flex h-[27.5px] items-center px-2 lg:hidden">
        <SkeletonText widths={['6.5rem']} />
      </span>
      <ProfileHeaderSkeleton />
      <TimelineOutline />
    </div>
  );
}

/** Contact 360 while it loads: the compact list, the contact column and (in the shell) the ribbon. */
export function Contact360Skeleton() {
  return (
    <div data-skeleton="contact-360" className={contact360Layout.grid}>
      <SkeletonStatus label="Loading this contact" />
      <div className={contact360Layout.listColumn}>
        <ContactListOutline compact />
      </div>
      <ContactViewSkeleton />
    </div>
  );
}
