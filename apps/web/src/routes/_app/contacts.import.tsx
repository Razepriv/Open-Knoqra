import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { ImportWizard } from '../../components/import/import-wizard';
import { MonoLabel } from '../../components/import/parts';
import { ImportSkeleton } from '../../components/skeletons/import-skeleton';

export const Route = createFileRoute('/_app/contacts/import')({
  staticData: { title: 'Import contacts' },
  pendingComponent: ImportSkeleton,
  component: ImportPage,
});

const CONTACTS_HREF = '/contacts';

/** Rendered inside the shell's <main>, so this is a section, not a second landmark. */
function ImportPage() {
  return (
    <section className="flex flex-1 flex-col gap-4">
      <div className="flex flex-col gap-3 px-1">
        <Link
          to="/contacts"
          className="inline-flex w-fit items-center gap-2 text-[14px] text-[color:var(--muted)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Contacts
        </Link>
        <MonoLabel>Contacts · Import</MonoLabel>
      </div>
      {/* The finish button is a full page load on purpose: the contacts list refetches fresh. */}
      <ImportWizard contactsHref={CONTACTS_HREF} />
    </section>
  );
}
