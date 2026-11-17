import type { Request } from "express";

/**
 * A request the control channel has already authenticated and authorised, handed to an application route in this process.
 *
 * It is kept in a WeakMap keyed by the in-memory request object, not in a header, a field or anything a client sends: a remote caller has no
 * way to put a request into this map, so `requireAuth` can accept it without any way for it to be forged.
 */
const principals = new WeakMap<object, string>();

export function setPeerPrincipal(req: Request, name: string): void {
  principals.set(req, name);
}

export function getPeerPrincipal(req: Request): string | null {
  return principals.get(req) ?? null;
}
