#!/usr/bin/env node
import { spawn } from "node:child_process";
import { currentCommit } from "./git-commit.mjs";

const port = Number.parseInt(process.env.PORT || "8787", 10);
const baseUrl = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ["scripts/run-api-local.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    JUICE_VERSION_COMMIT: process.env.JUICE_VERSION_COMMIT || currentCommit()
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  await waitForHealthy(baseUrl);
  const version = await getJson(`${baseUrl}/`);
  const health = await getJson(`${baseUrl}/healthz`);
  const authStart = await postJson(`${baseUrl}/auth/github/start`);

  console.log("Version:", JSON.stringify(version));
  console.log("Health:", JSON.stringify(health));
  console.log("GitHub auth start:", JSON.stringify({
    verification_uri: authStart.verification_uri,
    user_code: authStart.user_code ? "[present]" : undefined,
    device_code: authStart.device_code ? "[present]" : undefined
  }));
} finally {
  child.kill("SIGINT");
}

async function waitForHealthy(url) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited early with code ${child.exitCode}\n${output}`);
    }
    try {
      await getJson(`${url}/healthz`);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`API did not become healthy: ${lastError instanceof Error ? lastError.message : lastError}\n${output}`);
}

async function getJson(url) {
  const response = await fetch(url);
  return parseResponse(url, response);
}

async function postJson(url) {
  const response = await fetch(url, { method: "POST" });
  return parseResponse(url, response);
}

async function parseResponse(url, response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
