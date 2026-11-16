import { Button } from '@knoqra/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { dialogOverlay, iconPill } from '../lib/ui-classes';

export interface DialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  children: ReactNode;
  /** The id of the element to focus when the dialog opens. Defaults to the first focusable one. */
  initialFocusId?: string;
  /**
   * The element that gets focus when the dialog closes, read at that moment. Dialogs opened from a
   * menu item or an element that may unmount need this: left alone, focus would fall to the body.
   */
  returnFocus?: () => HTMLElement | null | undefined;
  /** `sm` for confirmations, `md` (the default) for forms. */
  size?: 'sm' | 'md';
}

const WIDTH = { sm: 'w-[min(460px,calc(100vw-24px))]', md: 'w-[min(520px,calc(100vw-24px))]' };

/**
 * Radix gives focus back when the dialog closes, but not when a parent that renders the dialog
 * only while it is open unmounts it instead: focus then falls to the body. This puts it back on
 * `returnFocus()` or, failing that, on whatever had focus when the dialog opened.
 */
function useFocusBackOnUnmount(open: boolean, returnFocus: DialogShellProps['returnFocus']) {
  const latest = useRef(returnFocus);
  latest.current = returnFocus;
  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      requestAnimationFrame(() => {
        // A deliberate click on a non-focusable area just before the unmount also leaves focus on
        // the body, so it too sends focus back to the opener: the same as Radix does on close.
        const lost = document.activeElement === null || document.activeElement === document.body;
        const target = latest.current?.() ?? opener;
        if (lost && target?.isConnected) target.focus();
      });
    };
  }, [open]);
}

/** The frame shared by every centred dialog: overlay, title, close button, description, focus. */
export function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  children,
  initialFocusId,
  returnFocus,
  size = 'md',
}: DialogShellProps) {
  useFocusBackOnUnmount(open, returnFocus);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content
          onOpenAutoFocus={(event) => {
            if (!initialFocusId) return;
            // Start in the first field, not on the Close button that comes first in the DOM.
            event.preventDefault();
            document.getElementById(initialFocusId)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocus) return;
            event.preventDefault();
            returnFocus()?.focus();
          }}
          className={`fixed top-1/2 left-1/2 z-50 max-h-[92dvh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[30px] border border-[color:var(--panelBorder)] bg-[color:var(--shell)] p-6 text-[color:var(--text)] [box-shadow:var(--panelShadow)] ${WIDTH[size]}`}
        >
          <div className="mb-1 flex items-start justify-between gap-4">
            <Dialog.Title className="font-[family-name:var(--font-display)] text-[26px] leading-[1.1] tracking-[-0.025em]">
              {title}
            </Dialog.Title>
            <Dialog.Close aria-label="Close" className={`${iconPill} size-10 shrink-0`}>
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-5 text-[14px] text-[color:var(--muted)] leading-relaxed">
            {description}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The Cancel button every confirmation shares. */
export function DialogCancel() {
  return (
    <Dialog.Close asChild>
      <Button variant="ghost">Cancel</Button>
    </Dialog.Close>
  );
}
