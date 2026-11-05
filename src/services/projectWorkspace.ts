import * as path from "path";
import { config } from "../config/env";
import type { Project } from "../entities/Project";

export function deployRoot(): string {
  return path.resolve(config.deployRoot);
}

export function projectRepoDir(project: Pick<Project, "id" | "name">): string {
  return path.join(deployRoot(), expectedComposeProjectName(project));
}

export function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function expectedComposeProjectName(project: Pick<Project, "id" | "name">): string {
  return `${project.id}-${slugify(project.name)}`;
}
