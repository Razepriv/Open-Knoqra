import type { components } from '@knoqra/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, throwIfFailed } from './api';

export type WalletSummary = components['schemas']['WalletSummary'];
export type WalletCredit = components['schemas']['WalletCredit'];

export const walletKey = ['wallet'] as const;

export function useWallet() {
  return useQuery({
    queryKey: walletKey,
    queryFn: async ({ signal }) =>
      throwIfFailed(await api.GET('/api/v1/wallet', { signal }), 'Could not load your wallet.'),
  });
}

/** Caps are in micros; null turns a cap off, and an omitted field is left as it is. */
export function useUpdateCaps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (caps: components['schemas']['UpdateWalletCaps']): Promise<WalletSummary> =>
      throwIfFailed(
        await api.PATCH('/api/v1/wallet/caps', { body: caps }),
        'Could not save the spend caps.',
      ),
    onSuccess: (summary) => {
      queryClient.setQueryData(walletKey, summary);
    },
  });
}

export function useAddCredit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      amountMicros: number;
      note: string;
      /** Reuse to retry one attempt safely; a fresh key is made when omitted. */
      idempotencyKey?: string;
    }): Promise<WalletCredit> =>
      throwIfFailed(
        await api.POST('/api/v1/wallet/credits', {
          body: {
            amountMicros: input.amountMicros,
            note: input.note,
            idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
          },
        }),
        'Could not add credit.',
      ),
    onSuccess: ({ wallet }) => {
      queryClient.setQueryData(walletKey, wallet);
      void queryClient.invalidateQueries({ queryKey: [...walletKey, 'ledger'] });
    },
  });
}
