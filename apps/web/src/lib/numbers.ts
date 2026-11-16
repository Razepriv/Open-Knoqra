import type { components } from '@knoqra/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, throwIfFailed } from './api';
import { setupKey } from './setup';

export type PhoneNumber = components['schemas']['PhoneNumber'];
export type AssignedUse = PhoneNumber['assignedUse'];

export const numbersKey = ['numbers'] as const;

export const CAPABILITY_LABELS: Record<keyof PhoneNumber['capabilities'], string> = {
  voice: 'Voice',
  sms: 'SMS',
  mms: 'MMS',
  whatsapp: 'WhatsApp',
};

/** The capabilities a number has, in display order. */
export function activeCapabilities(number: PhoneNumber): string[] {
  return (Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[])
    .filter((key) => number.capabilities[key])
    .map((key) => CAPABILITY_LABELS[key]);
}

export function useNumbers() {
  return useQuery({
    queryKey: numbersKey,
    queryFn: async ({ signal }) =>
      throwIfFailed(await api.GET('/api/v1/numbers', { signal }), 'Could not load your numbers.')
        .items,
  });
}

export function useSyncNumbers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      throwIfFailed(
        await api.POST('/api/v1/numbers/sync'),
        'Could not sync your numbers from your phone provider.',
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(numbersKey, result.items);
      void queryClient.invalidateQueries({ queryKey: setupKey });
    },
  });
}

export function useAssignNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; assignedUse: AssignedUse }): Promise<PhoneNumber> =>
      throwIfFailed(
        await api.PATCH('/api/v1/numbers/{id}', {
          params: { path: { id: input.id } },
          body: { assignedUse: input.assignedUse },
        }),
        'Could not assign this number.',
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: numbersKey });
      void queryClient.invalidateQueries({ queryKey: setupKey });
    },
  });
}

const MESSAGING_USES: readonly AssignedUse[] = ['messages', 'calls_and_messages'];

export type CheckStatus = 'pass' | 'fail' | 'pending';

export interface CapabilityTile {
  id: 'voice' | 'sms' | 'mms' | 'whatsapp';
  label: string;
  ready: boolean;
  reason: string;
}

interface CheckLike {
  id: string;
  status: CheckStatus;
  detail: string;
}

/**
 * The four capability tiles. Voice follows the number check, SMS and MMS need an assigned number
 * that has the capability plus 10DLC, and WhatsApp follows its own check.
 */
export function capabilityTiles(
  checks: readonly CheckLike[],
  numbers: readonly PhoneNumber[],
): CapabilityTile[] {
  const check = (id: string) => checks.find((item) => item.id === id);
  const number = check('number');
  const tenDlc = check('ten_dlc');
  const whatsapp = check('whatsapp');
  const messaging = (key: 'sms' | 'mms', label: string): CapabilityTile => {
    const owner = numbers.find(
      (item) => MESSAGING_USES.includes(item.assignedUse) && item.capabilities[key],
    );
    if (!owner) {
      return {
        id: key,
        label,
        ready: false,
        reason: numbers.some((item) => MESSAGING_USES.includes(item.assignedUse))
          ? `The number you use for messages cannot send ${label}.`
          : 'Assign a number for messages first.',
      };
    }
    const ready = tenDlc?.status === 'pass';
    return {
      id: key,
      label,
      ready,
      reason: ready
        ? 'Ready on your assigned number.'
        : (tenDlc?.detail ?? '10DLC is not checked.'),
    };
  };
  return [
    {
      id: 'voice',
      label: 'Voice',
      ready: number?.status === 'pass',
      reason: number?.status === 'pass' ? 'Ready on your assigned number.' : (number?.detail ?? ''),
    },
    messaging('sms', 'SMS'),
    messaging('mms', 'MMS'),
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      ready: whatsapp?.status === 'pass',
      reason: whatsapp?.status === 'pass' ? 'Approved by Meta.' : (whatsapp?.detail ?? ''),
    },
  ];
}
