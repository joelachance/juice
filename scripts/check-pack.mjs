import { execFileSync } from "node:child_process";

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

const packs = JSON.parse(output);
const files = packs[0]?.files?.map((file) => file.path) ?? [];
if (files.length === 0) {
  console.error("npm pack --dry-run returned no files");
  process.exit(1);
}

const forbidden = files.filter((path) =>
  path === "src/api" ||
  path.startsWith("src/api/") ||
  path === "dist/src/api" ||
  path.startsWith("dist/src/api/") ||
  path === "infra" ||
  path.startsWith("infra/") ||
  path.endsWith("/api/LICENSE") ||
  path === "src/api/LICENSE" ||
  path === "infra/LICENSE"
);

if (forbidden.length > 0) {
  console.error("Published tarball must not include server/infra/AGPL paths:");
  for (const path of forbidden) console.error(`- ${path}`);
  process.exit(1);
}

const required = ["LICENSE", "dist/src/sdk/index.js", "dist/src/cli/main.js"];
for (const path of required) {
  if (!files.includes(path)) {
    console.error(`Published tarball missing required path: ${path}`);
    process.exit(1);
  }
}

console.log(`Pack check ok (${files.length} files; no api/ or infra/).`);
