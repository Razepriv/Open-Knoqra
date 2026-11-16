import { Button } from '@knoqra/ui';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../lib/api';
import { useCreateTemplate } from '../../lib/inbox';
import { CHANNEL_LABEL, type InboxChannel } from '../../lib/inbox-format';
import { Field } from '../field';
import { FormAlert } from '../form-alert';
import { SelectField } from '../select-field';
import { TextareaField } from '../textarea-field';

const MAX_NAME = 60;
const MAX_BODY = 1024;
const MAX_META_NAME = 512;
const MAX_META_LANGUAGE = 6;

/** The optional Meta fields, sent only for WhatsApp and only when filled in. */
function metaFields(channel: InboxChannel, metaName: string, metaLanguage: string) {
  if (channel !== 'whatsapp') return {};
  const name = metaName.trim();
  const language = metaLanguage.trim();
  return {
    ...(name ? { whatsappTemplateName: name } : {}),
    ...(language ? { whatsappLanguage: language } : {}),
  };
}

/** Creates a template. The server checks the placeholders and decides the approval state. */
export function TemplateForm() {
  const create = useCreateTemplate();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<InboxChannel>('whatsapp');
  const [body, setBody] = useState('');
  const [metaName, setMetaName] = useState('');
  const [metaLanguage, setMetaLanguage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) return;
    setSaved(null);
    if (!name.trim() || !body.trim()) {
      setError('Give the template a name and a body.');
      return;
    }
    setError(null);
    try {
      const template = await create.mutateAsync({
        name: name.trim(),
        channel,
        body,
        ...metaFields(channel, metaName, metaLanguage),
      });
      setName('');
      setBody('');
      setMetaName('');
      setMetaLanguage('');
      setSaved(`Saved ${template.name}.`);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status < 500
          ? caught.message
          : 'We could not save this template. Try again.',
      );
    }
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      aria-labelledby="template-form-heading"
      className="flex flex-col gap-4 border-[color:var(--panelBorder)] border-t pt-5"
    >
      <h3
        id="template-form-heading"
        className="font-[family-name:var(--font-display)] font-medium text-[18px] leading-none"
      >
        New template
      </h3>
      <FormAlert message={error} />
      <FormAlert message={saved} tone="notice" />
      <Field
        id="template-name"
        label="Name"
        required
        maxLength={MAX_NAME}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <SelectField
        id="template-channel"
        label="Channel"
        value={channel}
        onChange={(event) => setChannel(event.target.value === 'sms' ? 'sms' : 'whatsapp')}
      >
        {(['whatsapp', 'sms'] as const).map((value) => (
          <option key={value} value={value}>
            {CHANNEL_LABEL[value]}
          </option>
        ))}
      </SelectField>
      <TextareaField
        id="template-body"
        label="Body"
        hint="Placeholders: {{first_name}} {{name}} {{company}}"
        maxLength={MAX_BODY}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {channel === 'whatsapp' ? (
        <>
          <Field
            id="template-meta-name"
            label="Meta template name"
            hint="As approved in Meta, for example table_ready"
            maxLength={MAX_META_NAME}
            autoComplete="off"
            spellCheck={false}
            value={metaName}
            onChange={(event) => setMetaName(event.target.value)}
          />
          <Field
            id="template-meta-language"
            label="Language"
            hint="Meta language code, for example en_US"
            maxLength={MAX_META_LANGUAGE}
            autoComplete="off"
            spellCheck={false}
            value={metaLanguage}
            onChange={(event) => setMetaLanguage(event.target.value)}
          />
        </>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending}
          aria-busy={create.isPending}
        >
          Create template
        </Button>
      </div>
    </form>
  );
}
