import { SkeletonBlock, SkeletonGroup, SkeletonLines } from '../calls/call-skeletons';
import { SettingsSection } from './section';

/**
 * The Connectors section's loading shapes. A leaf module: the Settings outline (in the initial
 * bundle) draws them without loading the section, its forms or its queries.
 */

/** The section's own heading, shared by the section and its loading outline. */
export const CONNECTORS_SECTION = {
  id: 'connectors',
  title: 'Connectors',
  description:
    'Connect the telephony provider your calls and numbers go through. A workspace uses one at a time.',
};

/** The whole Connectors section while the signed-in account (and so the role) is still loading. */
export function VoiceSectionSkeleton() {
  return (
    <SettingsSection {...CONNECTORS_SECTION}>
      <VoiceSkeleton />
    </SettingsSection>
  );
}

/** The status card, three labelled fields and the Save button, as the form lays them out. */
export function VoiceSkeleton() {
  return (
    <SkeletonGroup label="Loading the connectors" className="flex flex-col gap-5">
      <VoiceBodyBlocks />
    </SkeletonGroup>
  );
}

/** VoiceSkeleton's blocks without a status of their own, for the Settings page outline. */
export function VoiceBodyBlocks() {
  return (
    <>
      <div className="flex flex-col gap-2 rounded-[18px] bg-[color:var(--cell)] px-4 py-3">
        <SkeletonLines widths={[34, 70]} />
      </div>
      {[38, 52, 24].map((label) => (
        <div key={label} className="flex flex-col gap-2">
          <SkeletonLines widths={[label]} />
          <SkeletonBlock width="100%" height={48} className="rounded-2xl" />
          <SkeletonLines widths={[58]} />
        </div>
      ))}
      <SkeletonBlock width={168} height={44} className="rounded-[22px]" />
    </>
  );
}
