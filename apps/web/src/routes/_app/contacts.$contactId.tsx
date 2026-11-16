import { Button, Panel } from '@knoqra/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ConsentPanel } from '../../components/contact360/consent-panel';
import { DuplicateCards } from '../../components/contact360/duplicate-card';
import { ProfileHeader } from '../../components/contact360/profile-header';
import { Provenance } from '../../components/contact360/provenance';
import { Timeline } from '../../components/contact360/timeline';
import { ContactList } from '../../components/contacts/contact-list';
import { PageRibbon } from '../../components/shell/ribbon';
import {
  ConsentRibbonSkeleton,
  Contact360Skeleton,
  ContactViewSkeleton,
} from '../../components/skeletons/contact360-skeleton';
import { QueryStatePanel, StatePanel } from '../../components/states/state-panel';
import { ApiError } from '../../lib/api';
import {
  type TimelineFilter,
  useContact,
  usePermissions,
  useRestoreContact,
} from '../../lib/contact360-queries';
import type { Contact } from '../../lib/contacts';
import { contact360Layout } from '../../lib/contacts-layout';
import { CONTACTS_PATH } from '../../lib/nav-items';
import { focusRing } from '../../lib/ui-classes';

export const Route = createFileRoute('/_app/contacts/$contactId')({
  staticData: { title: 'Contact' },
  pendingComponent: Contact360Skeleton,
  component: ContactPage,
});

function ContactPage() {
  const { contactId } = Route.useParams();
  return (
    <div className={contact360Layout.grid}>
      <div className={contact360Layout.listColumn}>
        <ContactList compact activeId={contactId} />
      </div>
      {/* Keyed so switching contacts starts with a clean filter and composer. */}
      <ContactView key={contactId} contactId={contactId} />
    </div>
  );
}

const backLink = `inline-flex items-center gap-2 self-start rounded-full px-2 py-1 font-medium text-[13px] lg:hidden ${focusRing}`;

function ContactView({ contactId }: { contactId: string }) {
  const contact = useContact(contactId);
  const permissions = usePermissions(contactId);
  const [filter, setFilter] = useState<TimelineFilter>('all');

  // Wait for permissions too (they load in parallel): the header pills and consent rows change
  // size when they arrive, which would shift the timeline and the ribbon after first paint.
  if (contact.isPending || permissions.isPending) {
    // The header, timeline and Permissions ribbon in outline, so the columns are set before data.
    return (
      <>
        <ContactViewSkeleton label="Loading contact" />
        <PageRibbon label="Permissions">
          <ConsentRibbonSkeleton />
        </PageRibbon>
      </>
    );
  }
  // A failed background refresh keeps the data it already has, so only a first load can fail here.
  if (contact.data === undefined) {
    const missing = contact.error instanceof ApiError && contact.error.status === 404;
    return (
      <div className={contact360Layout.view}>
        <BackToContacts />
        {missing ? (
          // The record is the page, so its absence is the page's heading.
          <StatePanel
            kind="not-found"
            title="This contact doesn't exist or isn't in your workspace."
            body="It may have been removed, merged into another record, or shared from another workspace."
            headingLevel={1}
          />
        ) : (
          <QueryStatePanel
            error={contact.error}
            onRetry={() => void contact.refetch()}
            retrying={contact.isFetching}
            subject="this contact"
            headingLevel={1}
          />
        )}
      </div>
    );
  }

  const data = contact.data;
  const readOnly = data.archivedAt !== null || data.mergedIntoId !== null;
  return (
    <div className={contact360Layout.view}>
      <BackToContacts />
      <ArchivedBanner contact={data} />
      <ProfileHeader contact={data} permissions={permissions.data?.channels} />
      <Timeline
        contactId={contactId}
        filter={filter}
        onFilterChange={setFilter}
        readOnly={readOnly}
      />
      <PageRibbon label="Permissions">
        <Panel className="flex flex-1 flex-col gap-4 overflow-auto p-[18px]">
          <ConsentPanel contactId={contactId} contactName={data.displayName} readOnly={readOnly} />
          {readOnly ? null : (
            <DuplicateCards contactId={contactId} contactName={data.displayName} />
          )}
          <Provenance contact={data} />
        </Panel>
      </PageRibbon>
    </div>
  );
}

function BackToContacts() {
  return (
    <Link to={CONTACTS_PATH} className={backLink}>
      <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
      All contacts
    </Link>
  );
}

/** Archived contacts stay readable but frozen; a merged one points at where its history went. */
function ArchivedBanner({ contact }: { contact: Contact }) {
  const restore = useRestoreContact(contact.id);
  const [failed, setFailed] = useState(false);
  if (contact.archivedAt === null && contact.mergedIntoId === null) return null;
  const mergedHref: string | null = contact.mergedIntoId
    ? `/contacts/${contact.mergedIntoId}`
    : null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-[22px] border border-[color:var(--blocked-border)] px-4 py-3 [background:var(--blocked-stripe)]"
    >
      {mergedHref ? (
        <p className="flex-1 text-[14px] leading-snug">
          This contact was merged into another record. Its notes and history moved with it.{' '}
          <Link to={mergedHref} className={`font-semibold underline ${focusRing}`}>
            Open the merged contact
          </Link>
        </p>
      ) : (
        <>
          <p className="flex-1 text-[14px] leading-snug">
            This contact is archived. It stays out of your lists and cannot be changed until you
            restore it.
          </p>
          <Button
            variant="primary"
            onClick={() => restore.mutate(undefined, { onError: () => setFailed(true) })}
            aria-busy={restore.isPending}
          >
            Restore
          </Button>
        </>
      )}
      {failed ? (
        <p role="alert" className="basis-full text-[13px] text-[color:var(--danger-text)]">
          We could not restore this contact. Try again.
        </p>
      ) : null}
    </div>
  );
}
