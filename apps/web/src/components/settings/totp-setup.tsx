import { Button, Skeleton } from '@knoqra/ui';
import { toDataURL } from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { copy } from '../../lib/auth-errors';
import { groupSecret, normalizeCode, secretFromUri } from '../../lib/two-factor';
import { Field } from '../field';
import { FormAlert } from '../form-alert';

export interface TotpSetupProps {
  /** The otpauth:// URI from Better Auth. Held in memory only. */
  uri: string;
  pending: boolean;
  error: string | null;
  onVerify: (code: string) => void;
  onCancel: () => void;
}

/** Scan the QR (or type the key), then prove it works with a code. */
export function TotpSetup({ uri, pending, error, onVerify, onCancel }: TotpSetupProps) {
  const secret = secretFromUri(uri);
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [codeError, setCodeError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    // A QR must stay dark-on-light to scan, whatever the theme is, so these two are fixed.
    toDataURL(uri, { margin: 1, width: 192, color: { dark: '#131916', light: '#FFFFFF' } }).then(
      (url) => {
        if (!cancelled) {
          setQr(url);
          setQrFailed(false);
        }
      },
      () => {
        if (!cancelled) setQrFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uri]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = normalizeCode(String(new FormData(event.currentTarget).get('code') ?? ''));
    if (!code) {
      setCodeError('Enter the 6-digit code from your app.');
      return;
    }
    setCodeError(undefined);
    onVerify(code);
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-[52ch] text-[14px] text-[color:var(--muted)] leading-relaxed">
        Scan this code with an authenticator app such as 1Password, Authy or Google Authenticator.
      </p>
      <div className="flex flex-wrap items-start gap-5">
        <div className="size-[192px] shrink-0 overflow-hidden rounded-2xl bg-white [box-shadow:var(--cellShadow)]">
          {qr ? (
            <img
              src={qr}
              width={192}
              height={192}
              alt="QR code for your authenticator app"
              draggable={false}
            />
          ) : qrFailed ? (
            <p className="p-4 text-black text-[13px] leading-snug">
              Couldn't draw the QR code. Enter the key below instead.
            </p>
          ) : (
            <Skeleton variant="scan" width={192} height={192} label="Preparing your QR code" />
          )}
        </div>
        {secret ? (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="font-medium text-[13px]">Can't scan? Enter this key instead</p>
            <code
              data-testid="totp-secret"
              className="block rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 py-3 font-[family-name:var(--font-mono)] text-[14px] tracking-[.04em] [box-shadow:var(--cellShadow)]"
            >
              {groupSecret(secret)}
            </code>
          </div>
        ) : null}
      </div>
      <form className="flex max-w-[400px] flex-col gap-4" onSubmit={onSubmit} noValidate>
        <Field
          id="setup-code"
          name="code"
          label="Authentication code"
          hint="The 6-digit code your app shows now."
          autoComplete="one-time-code"
          inputMode="numeric"
          spellCheck={false}
          autoFocus
          error={codeError}
        />
        <FormAlert message={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
            Verify and enable
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {copy.cancel}
          </Button>
        </div>
      </form>
    </div>
  );
}
