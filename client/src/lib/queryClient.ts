import { QueryClient } from "@tanstack/react-query";

/** Shared cache for server data. Socket events update or invalidate it (see
 *  ActionTracker and the socket bridge), so queries mostly don't need to poll;
 *  refetch on focus and a short stale time are the safety net if an event is missed. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
