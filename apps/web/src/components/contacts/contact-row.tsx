import { Avatar, listRow } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { type Contact, formatPhone, gradientFor } from '../../lib/contacts';
import { focusRing } from '../../lib/ui-classes';

export interface ContactRowProps {
  contact: Contact;
  /** The narrow list beside Contact 360: avatar and name only, no phone column. */
  compact?: boolean;
  active?: boolean;
}

/** One contact in the list: a link to its 360 page. */
export function ContactRow({ contact, compact = false, active = false }: ContactRowProps) {
  // A plain string: typed route params would be stricter than this link needs.
  const href: string = `/contacts/${contact.id}`;
  return (
    <li>
      <Link
        to={href}
        aria-current={active ? 'page' : undefined}
        className={`${listRow.frame} text-left ${focusRing} ${active ? listRow.pressed : listRow.rest}`}
      >
        <Avatar name={contact.displayName} gradient={gradientFor(contact.id)} size={36} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-semibold text-[13.5px] leading-[1.1]">
            {contact.displayName}
          </span>
          <span className="truncate text-[12px] text-[color:var(--muted)] leading-none">
            {contact.company ?? (compact ? formatPhone(contact.phoneE164) : 'No company')}
          </span>
        </span>
        {compact ? null : (
          <span className="shrink-0 font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]">
            {formatPhone(contact.phoneE164)}
          </span>
        )}
      </Link>
    </li>
  );
}
