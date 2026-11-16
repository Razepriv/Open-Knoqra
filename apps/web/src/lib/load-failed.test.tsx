// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFailed } from './query-state';

afterEach(() => cleanup());

/** Switched on to make the next fetch fail as an offline fetch does. */
const network = { fail: false };
/** The rendered list's refetch, so the test can trigger a background refresh. */
const handle: { refetch: () => Promise<unknown> } = { refetch: async () => undefined };

/** A list rendered the way the views do: loading, then loadFailed, then the rows. */
function Devices() {
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      if (network.fail) throw new TypeError('Failed to fetch');
      return ['Chrome on Windows', 'Safari on iPhone'];
    },
  });
  handle.refetch = devices.refetch;
  if (devices.isPending) return createElement('p', null, 'Loading');
  if (loadFailed(devices)) return createElement('p', { role: 'alert' }, 'Could not load');
  return createElement(
    'ul',
    { 'aria-label': 'Devices' },
    devices.data?.map((name) => createElement('li', { key: name }, name)),
  );
}

describe('loadFailed', () => {
  it('is true only when the load failed with nothing to show', () => {
    expect(loadFailed({ isError: true, data: undefined })).toBe(true);
    expect(loadFailed({ isError: true, data: [] })).toBe(false);
    expect(loadFailed({ isError: true, data: null })).toBe(false);
    expect(loadFailed({ isError: false, data: undefined })).toBe(false);
  });

  it('keeps a populated list on screen when a refetch fails (as offline, with networkMode always)', async () => {
    network.fail = false;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, networkMode: 'always' } },
    });
    render(createElement(QueryClientProvider, { client }, createElement(Devices)));
    await waitFor(() => expect(screen.getByText('Chrome on Windows')).toBeTruthy());

    network.fail = true;
    await act(async () => {
      await handle.refetch();
    });
    // The refetch really failed, and the list is still there with no error state.
    expect(client.getQueryState(['devices'])?.status).toBe('error');
    expect(screen.getByText('Safari on iPhone')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
