import { getDatabase } from "../../../config/database";

/** The project groups an OAuth grant can be limited to: the dashboard groups projects by name (projects.group_name). */
export function listApiProjectGroupNames(): string[] {
  const rows = getDatabase().prepare("SELECT DISTINCT group_name AS name FROM projects WHERE group_name IS NOT NULL AND group_name != '' ORDER BY group_name").all() as { name: string }[];
  return rows.map((row) => row.name);
}
