import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());

vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return { ...original, api: { POST: post } };
});

import { ApiError } from './api';
import { postImportBatch } from './import-runner';

const request = { fileName: 'c.csv', onDuplicate: 'skip', rows: [{ displayName: 'Ada' }] } as const;

describe('postImportBatch', () => {
  beforeEach(() => post.mockReset());

  it('posts the batch to the import endpoint and unwraps the results', async () => {
    const results = [{ index: 0, status: 'created', contactId: 'ct_1', error: null }];
    post.mockResolvedValue({ data: { data: { results }, error: null }, response: { status: 200 } });

    await expect(postImportBatch({ ...request, rows: [...request.rows] })).resolves.toEqual(
      results,
    );
    expect(post).toHaveBeenCalledWith('/api/v1/contacts/import', {
      body: { ...request, rows: [...request.rows] },
    });
  });

  it('throws an ApiError carrying the status when the batch is refused', async () => {
    post.mockResolvedValue({
      error: { data: null, error: { code: 'payload_too_large', message: 'Too many rows.' } },
      response: { status: 413 },
    });

    const failure = await postImportBatch({ ...request, rows: [...request.rows] }).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 413, message: 'Too many rows.' });
  });
});
