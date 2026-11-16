import { defaultComplianceTexts, type SmsComplianceTexts } from '@knoqra/core';
import { Button } from '@knoqra/ui';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  type ChannelStatus,
  type SmsRegistrationRequest,
  useRefreshChannels,
  useRegisterSms,
  useResendSmsCode,
  useVerifySmsCode,
} from '../../lib/inbox';
import { DialogShell } from '../dialog-shell';
import { Field } from '../field';
import { FormAlert } from '../form-alert';
import { SelectField } from '../select-field';
import { TextareaField } from '../textarea-field';

type EntityType = SmsRegistrationRequest['entityType'];

const ENTITY_LABEL: Record<EntityType, string> = {
  sole_proprietor: 'Sole proprietor (no EIN)',
  private_profit: 'Private company',
  public_profit: 'Public company',
  non_profit: 'Non-profit',
};

const VERTICALS: Record<SmsRegistrationRequest['vertical'], string> = {
  PROFESSIONAL: 'Professional services',
  RETAIL: 'Retail',
  HEALTHCARE: 'Healthcare',
  REAL_ESTATE: 'Real estate',
  CONSTRUCTION: 'Construction and trades',
  HOSPITALITY: 'Hospitality',
  EDUCATION: 'Education',
  FINANCIAL: 'Financial',
  INSURANCE: 'Insurance',
  LEGAL: 'Legal',
  TECHNOLOGY: 'Technology',
  TRANSPORTATION: 'Transportation',
  COMMUNICATION: 'Communication',
  ENTERTAINMENT: 'Entertainment',
  MANUFACTURING: 'Manufacturing',
  AGRICULTURE: 'Agriculture',
  ENERGY: 'Energy',
  HUMAN_RESOURCES: 'Human resources',
  GOVERNMENT: 'Government',
  NGO: 'Non-profit organisation',
};

const USECASES: Record<NonNullable<SmsRegistrationRequest['usecase']>, string> = {
  CUSTOMER_CARE: 'Customer care: replies, appointments, support',
  ACCOUNT_NOTIFICATION: 'Account notifications',
  DELIVERY_NOTIFICATION: 'Delivery notifications',
  MARKETING: 'Marketing (offers and promotions)',
};

const TEXT_LABELS: Record<keyof SmsComplianceTexts, string> = {
  messageFlow: 'How people agree to texts',
  description: 'What you text about',
  optinMessage: 'Opt-in confirmation',
  helpMessage: 'HELP reply',
  optoutMessage: 'STOP reply',
  sample1: 'Sample message',
  sample2: 'Second sample message',
};

/** The form's fields, as strings. */
interface Form {
  entityType: EntityType;
  brandName: string;
  legalName: string;
  ein: string;
  firstName: string;
  lastName: string;
  email: string;
  contactPhone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  website: string;
  vertical: SmsRegistrationRequest['vertical'];
  usecase: NonNullable<SmsRegistrationRequest['usecase']>;
}

const EMPTY: Form = {
  entityType: 'private_profit',
  brandName: '',
  legalName: '',
  ein: '',
  firstName: '',
  lastName: '',
  email: '',
  contactPhone: '',
  street: '',
  city: '',
  state: '',
  postalCode: '',
  website: '',
  vertical: 'PROFESSIONAL',
  usecase: 'CUSTOMER_CARE',
};

/** The request for the form and its texts. */
export function registrationRequest(form: Form, texts: SmsComplianceTexts): SmsRegistrationRequest {
  const sole = form.entityType === 'sole_proprietor';
  const optional = (value: string) => (value.trim() ? value.trim() : undefined);
  return {
    entityType: form.entityType,
    brandName: form.brandName.trim(),
    ...(sole
      ? { firstName: form.firstName.trim(), lastName: form.lastName.trim() }
      : { legalName: form.legalName.trim(), ein: form.ein.trim(), usecase: form.usecase }),
    email: form.email.trim(),
    contactPhone: form.contactPhone.trim(),
    street: form.street.trim(),
    city: form.city.trim(),
    state: form.state.trim().toUpperCase(),
    postalCode: form.postalCode.trim(),
    ...(optional(form.website) ? { website: optional(form.website) } : {}),
    vertical: form.vertical,
    ...texts,
  } as SmsRegistrationRequest;
}

export interface SmsEnableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: ChannelStatus;
}

/**
 * Enable SMS: US business texting registration with the workspace's own phone provider account.
 * The carriers' texts (opt-in, HELP, STOP, samples) are prefilled from the business name in a
 * CTIA-compliant form and can be edited. A sole proprietor then enters the code texted to them.
 */
export function SmsEnableDialog({ open, onOpenChange, channel }: SmsEnableDialogProps) {
  const registration = channel.registration;
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Enable SMS"
      description="US carriers require businesses to register before texting. Registration fees are billed by your phone provider. Approval usually takes 1 to 3 business days."
    >
      {registration?.state === 'otp_required' ? (
        <CodeStep />
      ) : registration && registration.state !== 'failed' && registration.state !== 'rejected' ? (
        <ProgressStep channel={channel} />
      ) : (
        <DetailsStep failure={registration?.failureReason ?? null} />
      )}
    </DialogShell>
  );
}

function DetailsStep({ failure }: { failure: string | null }) {
  const register = useRegisterSms();
  const [form, setForm] = useState<Form>(EMPTY);
  const [edited, setEdited] = useState<Partial<SmsComplianceTexts>>({});
  const [error, setError] = useState<string | null>(failure);
  const defaults = defaultComplianceTexts({
    brandName: form.brandName,
    email: form.email,
    website: form.website,
  });
  const texts: SmsComplianceTexts = { ...defaults, ...edited };
  const sole = form.entityType === 'sole_proprietor';
  const set =
    <K extends keyof Form>(key: K) =>
    (value: Form[K]) =>
      setForm((f) => ({ ...f, [key]: value }));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    register.mutate(registrationRequest(form, texts), {
      onError: (e) =>
        setError(e instanceof ApiError ? e.message : 'Could not submit the registration.'),
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1"
    >
      <FormAlert message={error} />
      <SelectField
        id="sms-entity"
        label="Business type"
        value={form.entityType}
        onChange={(e) => set('entityType')(e.target.value as EntityType)}
      >
        {(Object.keys(ENTITY_LABEL) as EntityType[]).map((value) => (
          <option key={value} value={value}>
            {ENTITY_LABEL[value]}
          </option>
        ))}
      </SelectField>
      <Field
        id="sms-brand"
        label="Business name customers see"
        required
        value={form.brandName}
        onChange={(e) => set('brandName')(e.target.value)}
      />
      {sole ? (
        <div className="grid grid-cols-2 gap-3">
          <Field
            id="sms-first"
            label="First name"
            required
            value={form.firstName}
            onChange={(e) => set('firstName')(e.target.value)}
          />
          <Field
            id="sms-last"
            label="Last name"
            required
            value={form.lastName}
            onChange={(e) => set('lastName')(e.target.value)}
          />
        </div>
      ) : (
        <>
          <Field
            id="sms-legal"
            label="Legal business name"
            hint="As on your IRS records"
            required
            value={form.legalName}
            onChange={(e) => set('legalName')(e.target.value)}
          />
          <Field
            id="sms-ein"
            label="EIN"
            hint="XX-XXXXXXX"
            required
            value={form.ein}
            onChange={(e) => set('ein')(e.target.value)}
          />
        </>
      )}
      <Field
        id="sms-email"
        label="Support email"
        type="email"
        required
        value={form.email}
        onChange={(e) => set('email')(e.target.value)}
      />
      <Field
        id="sms-phone"
        label={sole ? 'Your mobile number' : 'Business phone'}
        hint={sole ? 'We text a code to this number to verify it is yours.' : undefined}
        type="tel"
        required
        value={form.contactPhone}
        onChange={(e) => set('contactPhone')(e.target.value)}
      />
      <Field
        id="sms-street"
        label="Street address"
        required
        value={form.street}
        onChange={(e) => set('street')(e.target.value)}
      />
      <div className="grid grid-cols-[1fr_80px_110px] gap-3">
        <Field
          id="sms-city"
          label="City"
          required
          value={form.city}
          onChange={(e) => set('city')(e.target.value)}
        />
        <Field
          id="sms-state"
          label="State"
          maxLength={2}
          required
          value={form.state}
          onChange={(e) => set('state')(e.target.value)}
        />
        <Field
          id="sms-zip"
          label="ZIP"
          maxLength={5}
          inputMode="numeric"
          required
          value={form.postalCode}
          onChange={(e) => set('postalCode')(e.target.value)}
        />
      </div>
      <Field
        id="sms-website"
        label="Website (optional)"
        value={form.website}
        onChange={(e) => set('website')(e.target.value)}
      />
      <SelectField
        id="sms-vertical"
        label="Industry"
        value={form.vertical}
        onChange={(e) => set('vertical')(e.target.value as Form['vertical'])}
      >
        {(Object.keys(VERTICALS) as Form['vertical'][]).map((value) => (
          <option key={value} value={value}>
            {VERTICALS[value]}
          </option>
        ))}
      </SelectField>
      {sole ? null : (
        <SelectField
          id="sms-usecase"
          label="What you will text"
          value={form.usecase}
          onChange={(e) => set('usecase')(e.target.value as Form['usecase'])}
        >
          {(Object.keys(USECASES) as Form['usecase'][]).map((value) => (
            <option key={value} value={value}>
              {USECASES[value]}
            </option>
          ))}
        </SelectField>
      )}
      <details className="rounded-[16px] border border-[color:var(--pillBorder)] px-4 py-3">
        <summary className="cursor-pointer font-medium text-[13.5px]">
          Message texts carriers review (prefilled)
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          {(Object.keys(TEXT_LABELS) as (keyof SmsComplianceTexts)[]).map((key) => (
            <TextareaField
              key={key}
              id={`sms-text-${key}`}
              label={TEXT_LABELS[key]}
              value={texts[key]}
              onChange={(e) => setEdited((current) => ({ ...current, [key]: e.target.value }))}
            />
          ))}
        </div>
      </details>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={register.isPending}
          aria-busy={register.isPending}
        >
          {register.isPending ? 'Submitting…' : 'Submit registration'}
        </Button>
      </div>
    </form>
  );
}

function CodeStep() {
  const verify = useVerifySmsCode();
  const resend = useResendSmsCode();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        verify.mutate(pin.trim(), {
          onError: (e) =>
            setMessage({
              ok: false,
              text: e instanceof ApiError ? e.message : 'Could not check the code.',
            }),
        });
      }}
    >
      <p className="text-[14px]">
        Enter the code we texted to your mobile to confirm the number is yours.
      </p>
      <FormAlert message={message?.ok ? null : (message?.text ?? null)} />
      <FormAlert message={message?.ok ? message.text : null} tone="notice" />
      <Field
        id="sms-code"
        label="Code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={10}
        value={pin}
        onChange={(e) => setPin(e.target.value)}
      />
      <div className="flex justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            resend.mutate(undefined, {
              onSuccess: () => setMessage({ ok: true, text: 'We sent a new code.' }),
              onError: () =>
                setMessage({ ok: false, text: 'Could not send a new code. Try again.' }),
            })
          }
        >
          Send a new code
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!/^\d{4,10}$/.test(pin.trim()) || verify.isPending}
        >
          Verify
        </Button>
      </div>
    </form>
  );
}

function ProgressStep({ channel }: { channel: ChannelStatus }) {
  const refresh = useRefreshChannels();
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-[14px]">
        {channel.detail}
      </p>
      <p className="text-[12.5px] text-[color:var(--muted)]">
        We check the registration every half hour and switch sending on as soon as it is approved.
      </p>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? 'Checking…' : 'Check now'}
        </Button>
      </div>
    </div>
  );
}
