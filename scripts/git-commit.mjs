import { execFileSync } from "node:child_process";

export function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || "local";
  } catch {
    return "local";
  }
}
