import { useState } from "react";
import { AppSelect } from "./AppSelect";
import { Input } from "./ui/input";
import type { Project } from "../api/types";

export function ProjectGroupField({value, onValueChange, projects, disabled}: {
  value: string; onValueChange: (value: string) => void; projects: Project[]; disabled?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const groups = [...new Set(projects.map(p => p.groupName).filter((name): name is string => !!name))].sort((a,b) => a.localeCompare(b));
  const isNew = creating || (!!value && !groups.includes(value));
  return (
    <div className="field">
      <label>Project group</label>
      <AppSelect value={isNew ? "new" : value ? `group:${value}` : ""} disabled={disabled}
        options={[{value: "", label: "Ungrouped"}, ...groups.map(name => ({value: `group:${name}`, label: name})), {value: "new", label: "New group…"}]}
        onValueChange={next => { setCreating(next === "new"); onValueChange(next.startsWith("group:") ? next.slice(6) : ""); }} />
      {isNew && <Input value={value} onChange={event => onValueChange(event.target.value)} disabled={disabled} maxLength={100} placeholder="e.g. Mw Control" aria-label="New project group name" />}
    </div>
  );
}
