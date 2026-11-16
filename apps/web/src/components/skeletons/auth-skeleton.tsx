import { SkeletonAuth, type SkeletonFieldProps, SkeletonText } from '@knoqra/ui';
import type { ReactNode } from 'react';
import type { AuthSkeletonId } from '../../lib/skeleton-routes';

interface AuthShape {
  label: string;
  fields: ReadonlyArray<SkeletonFieldProps>;
  afterFields?: ReactNode;
  afterButton?: ReactNode;
  /** The title wraps to two lines in the narrow card ("Forgot your password?"). */
  titleWraps?: boolean;
}

/** The "Forgot password?" link under the sign-in fields (it sits 8px closer, as on the form). */
const forgotLink = <SkeletonText widths={['38%']} className="-mt-2" />;

/** The "Trust this device" checkbox: an 18px box beside one line of label. */
const trustCheckbox = (
  <span aria-hidden="true" className="flex items-start gap-3">
    <span className="mt-[3px] size-[18px] shrink-0 rounded-[5px] border border-[color:var(--pillBorder)] bg-[color:var(--cell)]" />
    <SkeletonText widths={['62%']} lineHeight={19.25} className="flex-1" />
  </span>
);

const SHAPES: Record<AuthSkeletonId, AuthShape> = {
  'sign-in': { label: 'Loading sign in', fields: [{}, {}], afterFields: forgotLink },
  'sign-up': { label: 'Loading sign up', fields: [{}, {}, { hint: true }] },
  'forgot-password': { label: 'Loading password reset', fields: [{}], titleWraps: true },
  'reset-password': {
    label: 'Loading password reset',
    fields: [{ hint: true }, {}],
    titleWraps: true,
  },
  'two-factor': {
    label: 'Loading two-factor check',
    fields: [{ hint: true }],
    afterFields: trustCheckbox,
    titleWraps: true,
    // "Use a backup code instead" under the Verify button.
    afterButton: <SkeletonText widths={['52%']} />,
  },
};

/** The outline of one auth page: AuthLayout's two panels with that form's fields. */
export function AuthSkeleton({ route }: { route: AuthSkeletonId }) {
  const shape = SHAPES[route];
  return (
    <SkeletonAuth
      data-skeleton={route}
      label={shape.label}
      fields={shape.fields}
      afterFields={shape.afterFields}
      afterButton={shape.afterButton}
      titleWraps={shape.titleWraps}
    />
  );
}
