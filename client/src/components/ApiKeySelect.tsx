import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, PlusSquare } from "lucide-react";
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

const NONE_VALUE = "__stackport_no_api_key__";
const ADD_VALUE = "__stackport_add_api_key__";

interface ApiKeySelectProps {
  credentials: Credential[];
  value: number | null;
  onValueChange: (value: number | null) => void;
  placeholder?: string;
  noneLabel?: string;
  disabled?: boolean;
  className?: string;
}

function toSelectValue(value: number | null): string {
  return value == null ? NONE_VALUE : String(value);
}

function sortedApiKeyCredentials(credentials: Credential[]): Credential[] {
  return credentials
    .filter((credential) => credential.type === "api_key")
    .slice()
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

export function ApiKeySelect({
  credentials,
  value,
  onValueChange,
  placeholder = "Select API key",
  noneLabel = "None",
  disabled,
  className,
}: ApiKeySelectProps) {
  const navigate = useNavigate();
  const apiKeyCredentials = useMemo(() => sortedApiKeyCredentials(credentials), [credentials]);

  return (
    <Select
      value={toSelectValue(value)}
      disabled={disabled}
      onValueChange={(nextValue) => {
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
            New API Key
          </div>
        </SelectItem>
        <SelectSeparator className="github-token-action-separator" />
        <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem>
        {apiKeyCredentials.map((credential) => (
          <SelectItem key={credential.id} value={String(credential.id)}>
            <span className="github-token-option">
              <KeyRound size={13} />
              <span>{credential.alias}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
