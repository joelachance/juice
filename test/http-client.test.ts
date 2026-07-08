import assert from "node:assert/strict";
import test from "node:test";
import { apiBase } from "../src/http/client.js";

test("apiBase defaults to hosted Juice SaaS API", () => {
  assert.equal(apiBase({} as NodeJS.ProcessEnv), "https://api.juice.run");
});

test("apiBase allows self-hosted override", () => {
  assert.equal(apiBase({ JUICE_API_URL: "http://localhost:8787/" } as NodeJS.ProcessEnv), "http://localhost:8787");
});

test("apiBase rejects cleartext non-local endpoints unless explicitly allowed", () => {
  assert.throws(
    () => apiBase({ JUICE_API_URL: "http://api.example.com" } as NodeJS.ProcessEnv),
    /must use https/
  );
  assert.equal(
    apiBase({ JUICE_API_URL: "http://api.example.com", JUICE_ALLOW_INSECURE: "1" } as NodeJS.ProcessEnv),
    "http://api.example.com"
  );
});
