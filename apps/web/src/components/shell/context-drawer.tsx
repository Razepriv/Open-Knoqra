import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { Ref, RefObject } from 'react';
import { dialogOverlay, iconPill } from '../../lib/ui-classes';

export interface ContextDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  /** Receives the element the page's ribbon is portalled into. */
  targetRef: Ref<HTMLDivElement>;
  /** The control that opened the drawer; it gets focus back on close. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

/** The context ribbon as a right-hand drawer, for widths where there is no room for a third pane. */
export function ContextDrawer({
  open,
  onOpenChange,
  label,
  targetRef,
  returnFocusTo,
}: ContextDrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusTo.current?.focus();
          }}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(380px,100vw)] flex-col gap-3 overflow-y-auto bg-[color:var(--shell)] p-3 text-[color:var(--text)] [box-shadow:var(--shadow-drawer)]"
        >
          <div className="flex items-center justify-between gap-2 px-2 pt-1">
            <Dialog.Title className="font-[family-name:var(--font-display)] text-[20px] tracking-[-0.02em]">
              {label}
            </Dialog.Title>
            <Dialog.Close aria-label={`Close ${label}`} className={`${iconPill} size-10`}>
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div ref={targetRef} className="flex min-h-0 flex-1 flex-col" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
