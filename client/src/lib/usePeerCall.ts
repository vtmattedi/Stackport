import { useCallback, useRef } from "react";
import { api, ApiError, newOperationId } from "../api/client";

/**
 * A write to a peer, with an operation id that survives a retry.
 *
 * One id names one user action (this method, this path, this body). If the answer is lost, the peer may still have acted; repeating the same
 * call sends the same id, and the peer returns the first result instead of acting again. The id is dropped once the call ends in a way that
 * settles it: success, or an answer from the peer that it did nothing (any 4xx). A change to the body is a different action and gets a new id.
 */
export function usePeerCall(peerId: number) {
  const pending = useRef(new Map<string, string>());
  return useCallback(async <T,>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> => {
    const intent = `${method} ${path} ${JSON.stringify(body ?? {})}`;
    const operationId = pending.current.get(intent) ?? newOperationId();
    pending.current.set(intent, operationId);
    try {
      const result = await api.peerRequest<T>(peerId, method, path, body, operationId);
      pending.current.delete(intent);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) pending.current.delete(intent);
      throw error;
    }
  }, [peerId]);
}
