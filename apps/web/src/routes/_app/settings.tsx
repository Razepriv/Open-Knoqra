import { Panel, Reveal } from '@knoqra/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { OutageState } from '../../components/outage';
import { AboutSection } from '../../components/settings/about-section';
import { ConnectorsSection } from '../../components/settings/connectors-section';
import {
  PREFERENCES_SECTION,
  PreferencesSection,
} from '../../components/settings/preferences-section';
import { PROFILE_SECTION, ProfileSection } from '../../components/settings/profile-section';
import { SettingsSection } from '../../components/settings/section';
import { SecuritySection } from '../../components/settings/security-section';
import { SessionsSection } from '../../components/settings/sessions-section';
import { SystemStatusSection } from '../../components/settings/system-status-section';
import { VoiceSectionSkeleton } from '../../components/settings/voice-skeleton';
import {
  PreferencesBodySkeleton,
  ProfileBodySkeleton,
  SettingsSkeleton,
  SystemStatusPlaceholder,
} from '../../components/skeletons/settings-skeleton';
import { QueryStatePanel } from '../../components/states/state-panel';
import { deskSlot } from '../../extensions';
import { isUnreachable, useMe } from '../../lib/api';
import { loadFailed } from '../../lib/query-state';
import { canViewSystemStatus } from '../../lib/system-status';

export const Route = createFileRoute('/_app/settings')({
  staticData: { title: 'Settings' },
  pendingComponent: SettingsSkeleton,
  component: Settings,
});

/** What a settings section holds below its heading (see SettingsSection). */
const SECTION_BODY = 'section > :not(header)';

function Settings() {
  const me = useMe();
  // Sections an edition adds at the end of the right-hand column (extensions.ts).
  const ExtraSections = deskSlot('SettingsSections');
  if (loadFailed(me) && isUnreachable(me.error)) {
    return <OutageState onRetry={() => me.refetch()} retrying={me.isFetching} />;
  }

  return (
    <section className="flex flex-1 flex-col gap-4">
      <Panel className="flex flex-col gap-5 p-6 sm:p-9">
        <Link
          to="/"
          className="inline-flex items-center gap-2 self-start text-[14px] text-[color:var(--muted)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2"
        >
          <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          Back to your desk
        </Link>
        <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
          Account
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(36px,5vw,60px)] leading-[0.98] tracking-[-0.035em]">
          Settings
        </h1>
      </Panel>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          {loadFailed(me) ? (
            <QueryStatePanel
              error={me.error}
              onRetry={() => void me.refetch()}
              retrying={me.isFetching}
              subject="your settings"
            />
          ) : (
            <>
              {/* Decode the section body only: the heading is the same before and after. */}
              <Reveal loading={me.isPending} selector={SECTION_BODY}>
                {me.data ? (
                  <ProfileSection me={me.data} />
                ) : (
                  <SettingsSection {...PROFILE_SECTION}>
                    <ProfileBodySkeleton label="Loading your profile" />
                  </SettingsSection>
                )}
              </Reveal>
              <Reveal loading={me.isPending} selector={SECTION_BODY}>
                {me.data ? (
                  <PreferencesSection me={me.data} />
                ) : (
                  <SettingsSection {...PREFERENCES_SECTION}>
                    <PreferencesBodySkeleton label="Loading your preferences" />
                  </SettingsSection>
                )}
              </Reveal>
            </>
          )}
        </div>
        <div className="flex flex-col gap-4">
          <SecuritySection />
          <SessionsSection />
          {loadFailed(me) ? null : (
            <Reveal loading={me.isPending} selector={SECTION_BODY}>
              {me.data ? <ConnectorsSection me={me.data} /> : <VoiceSectionSkeleton />}
            </Reveal>
          )}
          {ExtraSections && me.data ? <ExtraSections me={me.data} /> : null}
        </div>
      </div>
      {me.isPending ? (
        // The role is not known yet: hold the owner-only section's place so it does not push
        // the page when it lands (it closes again if this account cannot see it).
        <SystemStatusPlaceholder />
      ) : me.data && canViewSystemStatus(me.data.organization.role) ? (
        <SystemStatusSection />
      ) : null}
      {/* Attribution and legal notices: required by ADDITIONAL-TERMS.md, keep them visible. */}
      <AboutSection />
    </section>
  );
}
