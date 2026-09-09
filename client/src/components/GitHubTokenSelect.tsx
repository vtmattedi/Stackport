import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, PlusSquare, Star } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import type { Credential } from "../api/types";
import { cn } from "../lib/utils";

const NONE_VALUE = "__stackport_no_github_token__";
const ADD_VALUE = "__stackport_add_github_token__";

interface GitHubTokenSelectProps {
  credentials: Credential[];
  value: number | null;
  onValueChange: (value: number | null) => void;
  placeholder?: string;
  noneLabel?: string;
  disabled?: boolean;
  className?: string;
  autoSelectDefault?: boolean;
  resetSignal?: unknown;
}

function toSelectValue(value: number | null): string {
  return value == null ? NONE_VALUE : String(value);
}

function sortedGitHubCredentials(credentials: Credential[]): Credential[] {
  return credentials
    .filter((credential) => credential.type === "github")
    .slice()
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.alias.localeCompare(b.alias));
}

export function GitHubTokenSelect({
  credentials,
  value,
  onValueChange,
  placeholder = "Select GitHub token",
  noneLabel = "None",
  disabled,
  className,
  autoSelectDefault = true,
  resetSignal,
}: GitHubTokenSelectProps) {
  const navigate = useNavigate();
  const [hasUserSelected, setHasUserSelected] = useState(false);
  const githubCredentials = useMemo(() => sortedGitHubCredentials(credentials), [credentials]);
  const defaultCredential = githubCredentials.find((credential) => credential.isDefault) ?? null;

  useEffect(() => {
    setHasUserSelected(false);
  }, [resetSignal]);

  useEffect(() => {
    if (autoSelectDefault && !hasUserSelected && value == null && defaultCredential) {
      onValueChange(defaultCredential.id);
    }
  }, [autoSelectDefault, defaultCredential, hasUserSelected, onValueChange, value]);

  return (
    <Select
      value={toSelectValue(value)}
      disabled={disabled}
      onValueChange={(nextValue) => {
        setHasUserSelected(true);
        if (nextValue === ADD_VALUE) {
          navigate("/credentials");
          return;
        }
        onValueChange(nextValue === NONE_VALUE ? null : Number(nextValue));
      }}
    >
      <SelectTrigger className={cn("app-select-trigger github-token-select-trigger", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectItem value={ADD_VALUE}>
          <div className="github-token-action">
            <PlusSquare size={13} />
            New Token
          </div>
        </SelectItem>
        <SelectSeparator className="github-token-action-separator" />
        <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem>
        {githubCredentials.map((credential) => (
          <SelectItem key={credential.id} value={String(credential.id)}>
            <span className="github-token-option">
              <KeyRound size={13} />
              <span>{credential.alias}</span>
              {credential.isDefault && (
                <span className="github-token-default">
                  <Star size={11} fill="currentColor" />
                  Default
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
