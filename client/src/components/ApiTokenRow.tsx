import { Trash2 } from "lucide-react";
import type { ApiToken } from "../api/types";
import { notify } from "../lib/notify";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { TimeAgo } from "./TimeAgo";

export function tokenState(token: ApiToken): "Revoked" | "Expired" | "Active" {
  if (token.revokedAt) return "Revoked";
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return "Expired";
  return "Active";
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify.success(`${what} copied.`);
  } catch (err) {
    notify.error(err, `Couldn't copy ${what.toLowerCase()}`);
  }
}

/** One API token: what it is on the first line, what it may do, when it was last used and when it expires on the second, so it reads at any width. */
export function ApiTokenRow({ token, access, onRevoke }: { token: ApiToken; access: string; onRevoke: (token: ApiToken) => void }) {
  const state = tokenState(token);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0">
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[13px] font-medium break-words">{token.name}</span>
          <Badge variant="outline" className={state === "Active" ? "border-[var(--success)] text-[var(--success)]" : "text-[var(--dim)]"}>{state}</Badge>
          <span className="mono">{token.prefix}…</span>
        </div>
        <div className="text-xs text-[var(--dim)]">
          {access} · last used {token.lastUsedAt ? <TimeAgo ts={token.lastUsedAt} /> : "never"} · expires {token.expiresAt ? new Date(token.expiresAt).toLocaleDateString() : "never"}
        </div>
      </div>
      {state === "Active" && (
        <Button type="button" variant="outline" size="sm" onClick={() => onRevoke(token)} aria-label={`Revoke ${token.name}`}>
          <Trash2 size={13} />Revoke
        </Button>
      )}
    </li>
  );
}
