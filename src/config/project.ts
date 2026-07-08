import { readFileSync, existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export type ProjectResolution = {
  project: string;
  root: string;
};

export function resolveJuiceEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.JUICE_ENV || env.APP_ENV || env.NODE_ENV || "development").trim();
}

export function isLocalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.JUICE_REMOTE === "1" || env.JUICE_REMOTE === "true") return false;
  const juiceEnv = resolveJuiceEnv(env).toLowerCase();
  return juiceEnv === "local" || juiceEnv === "development";
}

export function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "package.json")) || existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function resolveProject(start = process.cwd(), env: NodeJS.ProcessEnv = process.env): ProjectResolution {
  const root = findProjectRoot(start);
  const explicit = env.JUICE_PROJECT?.trim();
  if (explicit) return { project: explicit, root };

  const packageJsonPath = join(root, "package.json");
  if (existsSync(packageJsonPath)) {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    if (pkg.name?.trim()) return { project: pkg.name.trim(), root };
  }

  const fallback = parse(root).name;
  if (fallback) return { project: fallback, root };
  throw new Error("JUICE_PROJECT is required when Juice cannot infer a project name.");
}
