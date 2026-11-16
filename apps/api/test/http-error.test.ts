import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { httpExceptionResponse } from '../src/lib/http-error';
import { api, post, signUp, uniqueEmail } from './helpers';

type Envelope = { data: unknown; error: { code: string; message: string } | null };

const mapper = new Hono();
mapper.get('/s/:status', (c) => {
  const status = Number(c.req.param('status'));
  throw new HTTPException(status as 400, { message: `custom ${status}` });
});
mapper.get('/malformed', () => {
  throw new HTTPException(400, { message: 'Malformed JSON in request body' });
});
mapper.onError((error, c) =>
  error instanceof HTTPException ? httpExceptionResponse(error, c) : c.text('x', 500),
);

async function map(path: string) {
  const r = await mapper.request(path);
  return { status: r.status, body: (await r.json()) as Envelope };
}

describe('httpExceptionResponse', () => {
  it('keeps the exception message for a 400', async () => {
    const { status, body } = await map('/s/400');
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: 'validation_error', message: 'custom 400' });
    expect(body.data).toBeNull();
  });

  it('replaces the validator malformed-JSON message', async () => {
    const { body } = await map('/malformed');
    expect(body.error).toEqual({
      code: 'validation_error',
      message: 'The request body is not valid JSON.',
    });
  });

  it('maps 401 and 404 to their codes', async () => {
    expect((await map('/s/401')).body.error?.code).toBe('unauthenticated');
    expect((await map('/s/404')).body.error?.code).toBe('not_found');
  });

  it('maps other statuses to internal_error, keeping the status and hiding the text', async () => {
    const { status, body } = await map('/s/403');
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: 'internal_error', message: 'Something went wrong.' });
  });
});

describe('malformed JSON through the real API', () => {
  it('returns a validation_error envelope with a 400', async () => {
    const cookie = await signUp(uniqueEmail('badjson'));
    expect((await post('/api/v1/contacts', cookie, {})).status).toBe(400); // Zod hook path
    const broken = await api('/api/v1/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{not json',
    });
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as Envelope).error).toEqual({
      code: 'validation_error',
      message: 'The request body is not valid JSON.',
    });
  });
});
