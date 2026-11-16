import markUrl from '@knoqra/brand/assets/logo/knoqra-mark-2c-night.svg';
import { Link } from '@tanstack/react-router';

/** The official KNOQRA mark in its night tile, as on the Desk rail. */
export function BrandMark({ size = 46 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[15px] bg-[color:var(--mark-bg)] [box-shadow:var(--shadow-mark)]"
      style={{ width: size, height: size }}
    >
      <img src={markUrl} alt="" width={size * 0.66} height={size * 0.66} draggable={false} />
    </span>
  );
}

/** Mark plus wordmark, linking home. */
export function Brand() {
  return (
    <Link
      to="/"
      className="flex items-center gap-3 rounded-[18px] focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2"
    >
      <BrandMark />
      <span className="font-[family-name:var(--font-display)] font-medium text-[19px] tracking-[-0.02em]">
        KNOQRA
      </span>
    </Link>
  );
}
