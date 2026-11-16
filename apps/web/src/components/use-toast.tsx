import { Toast } from '@knoqra/ui';
import { type ReactNode, useCallback, useState } from 'react';

/** One toast at a time, centred at the bottom of the screen. Render `toast` once in the section. */
export function useToast(): { show: (message: string) => void; toast: ReactNode } {
  const [message, setMessage] = useState<string | null>(null);
  const show = useCallback((next: string) => setMessage(next), []);
  // The live region is always mounted and only its content changes, which is what makes screen
  // readers announce it. The toast inside it is not a second region.
  const toast = (
    <div role="status" className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 lg:bottom-6">
      {message ? (
        <Toast key={message} role="none" message={message} onDone={() => setMessage(null)} />
      ) : null}
    </div>
  );
  return { show, toast };
}
