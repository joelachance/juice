import { readFileSync } from "node:fs";
import { join } from "node:path";

export type VersionInfo = {
  service: "juice-api";
  commit: string;
  version: string;
};

export function versionInfo(env: NodeJS.ProcessEnv = process.env): VersionInfo {
  return {
    service: "juice-api",
    commit: env.JUICE_VERSION_COMMIT?.trim() || "unknown",
    version: packageVersion()
  };
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}
