import { createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';
import { ContactList } from '../../components/contacts/contact-list';
import { ContactsSkeleton } from '../../components/skeletons/contacts-skeleton';

export const Route = createFileRoute('/_app/contacts/')({
  staticData: { title: 'Contacts' },
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === 'string' && search.q ? { q: search.q } : {},
  pendingComponent: ContactsSkeleton,
  component: ContactsPage,
});

function ContactsPage() {
  const { q } = Route.useSearch();
  // A new key for each navigation that lands, including one back to the same address.
  const navigationKey = useRouterState({
    select: (state) => state.resolvedLocation?.state.__TSR_key,
  });
  const navigate = useNavigate({ from: Route.fullPath });
  // The search text lives in the URL, so a refresh or a shared link keeps the filter.
  const onQueryChange = useCallback(
    (next: string) => void navigate({ search: next ? { q: next } : {}, replace: true }),
    [navigate],
  );
  return (
    <ContactList
      initialQuery={q ?? ''}
      navigationKey={navigationKey}
      onQueryChange={onQueryChange}
    />
  );
}
