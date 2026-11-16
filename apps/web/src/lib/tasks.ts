import type { components } from '@knoqra/api-client';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, NetworkError, throwIfFailed } from './api';

export type Task = components['schemas']['Task'];
export type CreateTaskBody = components['schemas']['CreateTask'];
export type UpdateTaskBody = components['schemas']['UpdateTask'];
export type TaskStatus = Task['status'];

export const tasksKey = ['tasks'] as const;

/** Tasks in `status`, 50 at a time, following the API's opaque `nextCursor`. */
export function useTasks(status: TaskStatus) {
  return useInfiniteQuery({
    queryKey: [...tasksKey, status],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/tasks', {
          params: { query: { status, ...(pageParam ? { cursor: pageParam } : {}) } },
          signal,
        }),
        'Could not load your tasks.',
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** A task change moves things on Today, in the bell and in the contact's timeline too. */
function useRefreshAfterChange() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: tasksKey }),
      queryClient.invalidateQueries({ queryKey: ['today'] }),
      queryClient.invalidateQueries({ queryKey: ['notifications'] }),
      queryClient.invalidateQueries({ queryKey: ['timeline'] }),
    ]);
}

export function useCreateTask() {
  const refresh = useRefreshAfterChange();
  return useMutation({
    mutationFn: async (body: CreateTaskBody) =>
      throwIfFailed(await api.POST('/api/v1/tasks', { body }), 'Could not save this task.'),
    onSuccess: refresh,
  });
}

export function useUpdateTask() {
  const refresh = useRefreshAfterChange();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: UpdateTaskBody }) =>
      throwIfFailed(
        await api.PATCH('/api/v1/tasks/{id}', { params: { path: { id } }, body }),
        'Could not save this task.',
      ),
    onSuccess: refresh,
  });
}

export function useDeleteTask() {
  const refresh = useRefreshAfterChange();
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await api.DELETE('/api/v1/tasks/{id}', { params: { path: { id } } });
      if (!result.response.ok) {
        throw new ApiError(result.response.status, 'Could not delete this task.');
      }
    },
    onSuccess: refresh,
  });
}

/** Our own wording for a failed save, so no server text reaches the screen. */
export function taskErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'We could not reach KNOQRA. Check your connection and try again.';
  }
  if (error instanceof ApiError && error.code === 'validation_error') {
    return 'Some details are not valid. Check them and try again.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'That task or contact is no longer available.';
  }
  return 'We could not save this task. Try again in a moment.';
}
