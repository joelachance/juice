import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("npm pack excludes api and infra from the published tarball", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const packs = JSON.parse(output) as Array<{ files?: Array<{ path: string }> }>;
  const files = (packs[0]?.files ?? []).map((file) => file.path);
  assert(files.some((path) => path.startsWith("dist/src/sdk/")));
  assert(files.some((path) => path.startsWith("dist/src/cli/")));
  assert.equal(files.some((path) => path.includes("/api/") || path.startsWith("dist/src/api") || path.startsWith("infra/")), false);
  assert(files.includes("LICENSE"));
  assert.equal(files.includes("src/api/LICENSE"), false);
  assert.equal(files.includes("infra/LICENSE"), false);
});
