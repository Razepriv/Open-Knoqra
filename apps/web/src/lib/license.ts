import type { components } from '@knoqra/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, throwIfFailed } from './api';

export type LicenseStatus = components['schemas']['LicenseStatus'];

export const licenseKey = ['license'] as const;

/**
 * Where a self-hosted instance sends people for a key: KNOQRA's cloud API, which signs them in
 * with GitHub. A build can point elsewhere with VITE_LICENSE_ISSUER_URL.
 */
export const LICENSE_ISSUER_URL =
  import.meta.env.VITE_LICENSE_ISSUER_URL?.trim() ||
  'https://app.knoqra.app/api/license/github/start';

/** This instance's edition and license. Every signed-in member may read it. */
export function useLicense(enabled = true) {
  return useQuery({
    queryKey: licenseKey,
    enabled,
    // The edition never changes while the page is open; the license only changes through the
    // setup screen, which writes the answer into the cache itself.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) =>
      throwIfFailed(await api.GET('/api/v1/license', { signal }), 'Could not check the license.'),
  });
}

export function useEnterLicense() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: string): Promise<LicenseStatus> =>
      throwIfFailed(await api.PUT('/api/v1/license', { body: { key } }), 'Could not save the key.'),
    onSuccess: (status) => {
      queryClient.setQueryData(licenseKey, status);
    },
  });
}

/** True when this instance must show the license screen instead of the Desk. */
export function needsLicense(status: LicenseStatus): boolean {
  return status.required && !status.licensed;
}

/** A pasted key, tidied: surrounding whitespace and line breaks a copy may add are dropped. */
export function tidyLicenseKey(text: string): string {
  return text.replace(/\s+/g, '');
}
