import assert from "node:assert/strict";
import test from "node:test";
import { juiceLogoRaw, rootHelpText } from "../src/cli/main.js";

test("root help starts with ASCII logo and renders gx-style sections", () => {
  const text = rootHelpText({ authConfigured: false });

  assert(text.startsWith(`${juiceLogoRaw}\n`));
  assert.match(text, /agent secrets without copy\/paste/);
  assert.match(text, /Not signed in  juice auth login/);
  assert.match(text, /\$ juice help/);

  const ordered = [
    "Usage:",
    "  juice [command]",
    "Setup:",
    "  auth",
    "Secrets:",
    "  set",
    "Help:",
    "  help",
    "Flags:",
    "  -h, --help"
  ];
  let previous = -1;
  for (const want of ordered) {
    const index = text.indexOf(want);
    assert.notEqual(index, -1, `missing ${want} in:\n${text}`);
    assert(index > previous, `${want} rendered out of order:\n${text}`);
    previous = index;
  }
});

test("root help shows configured token status", () => {
  const text = rootHelpText({ authConfigured: true });
  assert.match(text, /Token configured/);
});
