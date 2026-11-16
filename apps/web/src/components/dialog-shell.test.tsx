// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DialogShell } from './dialog-shell';

/**
 * A parent that renders the dialog only while it is open, as the wallet panel's caps dialog does.
 * With `useReturnFocus`, the dialog hands focus to the "Elsewhere" button instead of the opener.
 */
function MountedWhileOpen({ useReturnFocus = false }: { useReturnFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const elsewhere = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Edit caps
      </button>
      <button type="button" ref={elsewhere}>
        Elsewhere
      </button>
      {open ? (
        <DialogShell
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
          title="Spend caps"
          description="Limits on call spend."
          {...(useReturnFocus ? { returnFocus: () => elsewhere.current } : {})}
        >
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </DialogShell>
      ) : null}
    </div>
  );
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

/** Opens the dialog from its opener, which has focus first, as a click would leave it. */
function openDialog(props: { useReturnFocus?: boolean } = {}) {
  render(<MountedWhileOpen {...props} />);
  const opener = screen.getByRole('button', { name: 'Edit caps' });
  opener.focus();
  fireEvent.click(opener);
  expect(screen.getByRole('dialog', { name: 'Spend caps' })).toBeTruthy();
  return opener;
}

describe('DialogShell', () => {
  afterEach(cleanup);

  it('gives focus back to the opener when the parent unmounts it instead of closing it', async () => {
    const opener = openDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(nextFrame);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus alone when something else took it before the next frame', async () => {
    openDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(nextFrame);

    expect(document.activeElement).toBe(elsewhere);
  });

  it('prefers returnFocus() over the opener', async () => {
    const opener = openDialog({ useReturnFocus: true });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(nextFrame);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(document.activeElement).not.toBe(opener);
  });
});
