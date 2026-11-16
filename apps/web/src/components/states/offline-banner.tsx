import { useOnline } from '../../lib/use-online';

/**
 * A thin banner shown while the browser is offline. The live region is always mounted and only its
 * text changes, which is what makes screen readers announce it. While online it is taken out of the
 * flow (sr-only), so the empty region adds no gap to the column it sits in.
 */
export function OfflineBanner() {
  const online = useOnline();
  return (
    <div role="status" data-testid="offline-banner" className={online ? 'sr-only' : undefined}>
      {online ? null : (
        <p className="rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 py-2 text-[13px] [box-shadow:var(--cellShadow)]">
          {"You're offline. Changes will not save until you reconnect."}
        </p>
      )}
    </div>
  );
}
