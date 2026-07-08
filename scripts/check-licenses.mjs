import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const nodeModules = join(root, "node_modules");
const allowed = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "Unlicense",
  "AGPL-3.0-or-later",
  "GPL-3.0-or-later",
  "LGPL-3.0-or-later"
];

async function packageDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      dirs.push(...await packageDirs(full));
    } else {
      dirs.push(full);
    }
  }
  return dirs;
}

function normalizeLicense(license) {
  if (typeof license === "string") return license.replace(/[()]/g, "").trim();
  if (license?.type) return String(license.type);
  return "";
}

const failures = [];
for (const dir of await packageDirs(nodeModules)) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const license = normalizeLicense(pkg.license);
    const expressions = license.split(/\s+(?:OR|AND)\s+/);
    if (!expressions.some((expr) => allowed.includes(expr))) {
      failures.push(`${pkg.name}@${pkg.version}: ${license || "missing license"}`);
    }
  } catch {
    failures.push(`${dir}: missing package.json`);
  }
}

if (failures.length > 0) {
  console.error("Incompatible or unknown dependency licenses:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Dependency licenses are compatible with copyleft distribution.");
