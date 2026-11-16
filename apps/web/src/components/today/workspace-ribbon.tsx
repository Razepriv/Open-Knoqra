import { Panel } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { FileUp, Phone, UserPlus } from 'lucide-react';
import { CONTACTS_IMPORT_PATH, CONTACTS_PATH } from '../../lib/nav-items';
import { focusRing } from '../../lib/ui-classes';

const stepLink = `flex items-center gap-3 rounded-[16px] bg-[color:var(--cell)] px-3 py-3 font-medium text-[14px] [box-shadow:var(--cellShadow)] ${focusRing}`;

/** Getting started, in Today's context ribbon. */
export function WorkspaceRibbon() {
  return (
    <Panel className="flex flex-1 flex-col gap-4 overflow-auto p-[18px]">
      <h2 className="font-[family-name:var(--font-display)] font-medium text-[18px] leading-none">
        Workspace
      </h2>
      <p className="text-[12.5px] text-[color:var(--muted)] leading-[1.45]">
        Start with the people you talk to. Each one gets a record with its own consent per channel.
      </p>
      <ul className="flex flex-col gap-2">
        <li>
          <Link to={CONTACTS_PATH} className={stepLink}>
            <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />
            Add your first contact
          </Link>
        </li>
        <li>
          <Link to={CONTACTS_IMPORT_PATH} className={stepLink}>
            <FileUp size={16} strokeWidth={1.75} aria-hidden="true" />
            Import a CSV
          </Link>
        </li>
        <li className="flex items-center gap-3 rounded-[16px] border-[1.5px] border-[color:var(--muted)] border-dashed px-3 py-3 font-medium text-[14px] text-[color:var(--muted)]">
          <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
          Connect a number
          <span className="ml-auto font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[.04em]">
            Coming in M2
          </span>
        </li>
      </ul>
    </Panel>
  );
}
