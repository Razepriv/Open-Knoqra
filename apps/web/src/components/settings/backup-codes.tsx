import { Button } from '@knoqra/ui';
import { Copy, Download } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { downloadTextFile } from '../../lib/download';
import { backupCodesFile } from '../../lib/two-factor';

export interface BackupCodesProps {
  codes: readonly string[];
  /** Tells the user about the outcome of copy: success or a failure they can act on. */
  onNotice: (message: string) => void;
  onDone: () => void;
}

/**
 * The one-time view of the backup codes. They live only in this component's props: nothing is
 * logged or stored in the browser, and once the user is done they cannot be shown again.
 */
export function BackupCodes({ codes, onNotice, onDone }: BackupCodesProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The form that was focused is gone: put focus where the new content starts.
  useEffect(() => heading.current?.focus(), []);

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      onNotice('Backup codes copied');
    } catch {
      onNotice('Could not copy. Download the codes instead.');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h3 ref={heading} tabIndex={-1} className="font-semibold text-[16px] outline-none">
          Your backup codes
        </h3>
        <p className="max-w-[52ch] text-[14px] text-[color:var(--muted)] leading-relaxed">
          Each code signs you in once if you lose your authenticator. Save them now: you will not be
          shown them again.
        </p>
      </div>
      <ul
        aria-label="Backup codes"
        className="grid grid-cols-2 gap-2 rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] p-4 [box-shadow:var(--cellShadow)]"
      >
        {codes.map((code) => (
          <li
            key={code}
            className="font-[family-name:var(--font-mono)] text-[14px] tracking-[.02em]"
          >
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={copyCodes}>
          <Copy size={15} strokeWidth={1.75} aria-hidden="true" />
          Copy codes
        </Button>
        <Button
          variant="ghost"
          onClick={() => downloadTextFile('knoqra-backup-codes.txt', backupCodesFile(codes))}
        >
          <Download size={15} strokeWidth={1.75} aria-hidden="true" />
          Download codes
        </Button>
        <Button variant="primary" onClick={onDone}>
          I've saved these codes
        </Button>
      </div>
    </div>
  );
}
