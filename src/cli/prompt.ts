/**
 * Terminal input, and the rules about what must never reach it.
 *
 * A secret value is read with echo off and never from argv, and there is no
 * readline fallback: without a TTY `juice set KEY` used to print a prompt,
 * resolve nothing, and let node exit 0 having stored nothing at all.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";


export function valueAsArgumentError(key: string): string {
  return [
    "A secret value cannot be an argument — it lands in `ps` and in shell history,",
    "and deleting it later does not help.",
    "",
    `  interactive   juice set ${key} --scope <name>`,
    `  scripted      printf %s "$VALUE" | juice set ${key} --scope <name> --stdin`
  ].join("\n");
}

export function stripOneTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** `~`-relative where possible; absolute paths in output are noise. */
export function displayPath(path: string, home = homedir()): string {
  const absolute = resolve(path);
  const fromCwd = relative(process.cwd(), absolute);
  if (fromCwd && !fromCwd.startsWith("..")) return fromCwd;
  const fromHome = relative(home, absolute);
  if (fromHome && !fromHome.startsWith("..")) return join("~", fromHome);
  return absolute;
}

export async function confirm(message: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!input.isTTY) {
    throw new Error("Pass --yes to confirm in non-interactive mode.");
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function promptSecret(prompt: string): Promise<string> {
  // Without a TTY there is nothing to prompt. Falling back to readline here
  // meant `juice set KEY < /dev/null` printed the prompt, never resolved, and
  // let node exit 0 with nothing stored — success reported for a lost secret.
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("No terminal to read a secret from. Pipe the value instead: printf %s \"$VALUE\" | juice set KEY --scope <name> --stdin");
  }
  return hiddenPrompt(prompt);
}

function hiddenPrompt(prompt: string): Promise<string> {
  return new Promise((resolvePrompt, reject) => {
    let value = "";
    output.write(prompt);
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      input.setRawMode(false);
      input.off("keypress", onKeypress);
      output.write("\n");
    };

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolvePrompt(value);
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (str) value += str;
    };

    input.on("keypress", onKeypress);
  });
}

