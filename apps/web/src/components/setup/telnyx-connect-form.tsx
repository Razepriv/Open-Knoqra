import { Button } from '@knoqra/ui';
import { type FormEvent, useState } from 'react';
import { useSaveVoiceConnection, voiceConnectionErrorCopy } from '../../lib/voice-connection';
import { Field } from '../field';
import { FormAlert } from '../form-alert';

const E164 = /^\+[1-9]\d{6,14}$/;

interface Errors {
  apiKey?: string;
  connectionId?: string;
  callerId?: string;
}

function validate(apiKey: string, connectionId: string, callerId: string): Errors {
  const errors: Errors = {};
  if (!apiKey.trim()) errors.apiKey = 'Enter your Telnyx API key.';
  if (!connectionId.trim()) errors.connectionId = 'Enter your credential connection id.';
  if (!E164.test(callerId.replace(/[\s()-]/g, ''))) {
    errors.callerId = 'Enter a full number with country code, like +1 202 555 0100.';
  }
  return errors;
}

export interface TelnyxConnectFormProps {
  /** Called after the key is saved and the balance refresh was asked for. */
  onSaved?: () => void;
  submitLabel?: string;
}

/** The Telnyx API key, credential connection id and caller id. The key is never shown again. */
export function TelnyxConnectForm({
  onSaved,
  submitLabel = 'Save connection',
}: TelnyxConnectFormProps) {
  const save = useSaveVoiceConnection();
  const [apiKey, setApiKey] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [callerId, setCallerId] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(apiKey, connectionId, callerId);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    save.mutate(
      {
        apiKey: apiKey.trim(),
        connectionId: connectionId.trim(),
        callerIdE164: callerId.replace(/[\s()-]/g, ''),
      },
      {
        onSuccess: () => {
          setApiKey('');
          // Drop the key from the mutation cache (`save.variables`).
          save.reset();
          onSaved?.();
        },
      },
    );
  };

  // The same wording as the Settings voice section, never the server's text.
  const failure = save.isError ? voiceConnectionErrorCopy(save.error) : null;

  return (
    <form onSubmit={submit} noValidate className="flex max-w-[440px] flex-col gap-5">
      <Field
        id="telnyx-api-key"
        label="API key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        hint="Stored encrypted. KNOQRA never shows the full key again."
        error={errors.apiKey}
      />
      <Field
        id="telnyx-connection-id"
        label="Credential connection id"
        autoComplete="off"
        spellCheck={false}
        required
        value={connectionId}
        onChange={(event) => setConnectionId(event.target.value)}
        error={errors.connectionId}
      />
      <Field
        id="telnyx-caller-id"
        label="Caller id"
        type="tel"
        autoComplete="off"
        required
        placeholder="+1 202 555 0100"
        value={callerId}
        onChange={(event) => setCallerId(event.target.value)}
        error={errors.callerId}
      />
      <FormAlert message={failure} />
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        aria-busy={save.isPending}
        disabled={save.isPending}
      >
        {save.isPending ? 'Saving…' : submitLabel}
      </Button>
    </form>
  );
}
