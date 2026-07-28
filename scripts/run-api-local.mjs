#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { currentCommit } from "./git-commit.mjs";
import { loadServerEnvFile } from "../dist/src/api/env-file.js";

// Load the config file BEFORE filling in defaults. The other order looks
// harmless and is not: the ephemeral secret below would be generated first,
// process.env would already hold JUICE_TOKEN_SECRET, and the value in .env
// would be silently skipped — so every restart would invalidate the tokens
// issued by the previous one, with nothing on screen to explain why.
loadServerEnvFile();

process.env.JUICE_VERSION_COMMIT ||= currentCommit();
if (!process.env.JUICE_TOKEN_SECRET) {
  process.env.JUICE_TOKEN_SECRET = randomBytes(32).toString("base64url");
  console.error("No JUICE_TOKEN_SECRET set; generated an ephemeral one.");
  console.error("Sessions will not survive a restart. Put one in .env to keep them.");
}

// Login needs all three. Failing at `juice auth login` with a 501 is a long way
// from the cause, so say it at startup instead.
for (const [name, hint] of [
  ["JUICE_CONVEX_URL", "https://<deployment>.convex.site"],
  ["JUICE_CONVEX_SECRET", "must match JUICE_API_SHARED_SECRET in Convex"],
  ["GITHUB_CLIENT_ID", "Iv23li… — the Client ID, not the App ID"]
]) {
  if (!process.env[name]) console.error(`warning: ${name} is unset (${hint}); \`juice auth login\` will fail.`);
}

await import("../dist/src/api/main.js");
