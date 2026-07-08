#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { currentCommit } from "./git-commit.mjs";

process.env.JUICE_VERSION_COMMIT ||= currentCommit();
if (!process.env.JUICE_TOKEN_SECRET) {
  process.env.JUICE_TOKEN_SECRET = randomBytes(32).toString("base64url");
  console.error("Generated ephemeral JUICE_TOKEN_SECRET for this local API process.");
}

await import("../dist/src/api/main.js");
