/**
 * The interactive fallback for a missing `--scope`.
 *
 * Requiring an explicit scope is right, and typing it on every command all day
 * is not. The compromise: when a human is at the keyboard, ask — offering the
 * scopes this machine has used before so the common case is one keystroke.
 *
 * The rule that matters is what happens when nobody is there. A prompt that
 * cannot be shown must be a hard error, because the whole point of dropping
 * inference was that a silent default is how secrets end up in the wrong place.
 * Scripts and CI get the error and pass `--scope`.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { MISSING_SCOPE_MESSAGE, readKnownScopes } from "../config/scope.js";
import { assertScope } from "../config/secret-path.js";

export async function pickScope(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!input.isTTY) throw new Error(MISSING_SCOPE_MESSAGE);

  const known = readKnownScopes(env);
  const rl = createInterface({ input, output });
  try {
    if (known.length === 0) {
      const typed = await rl.question("Scope for this secret: ");
      return assertScope(typed);
    }

    output.write("Which scope?\n");
    known.forEach((scope, index) => output.write(`  ${index + 1}. ${scope}\n`));
    output.write(`  ${known.length + 1}. (a different scope)\n`);

    const answer = (await rl.question(`Choose 1-${known.length + 1}, or type a scope name: `)).trim();
    const chosen = Number.parseInt(answer, 10);

    if (Number.isInteger(chosen) && chosen >= 1 && chosen <= known.length) {
      return known[chosen - 1];
    }
    if (chosen === known.length + 1 || answer === "") {
      const typed = await rl.question("Scope name: ");
      return assertScope(typed);
    }
    // Anything else is treated as a scope name typed directly, so the fast path
    // for a scope not in the list is to just type it.
    return assertScope(answer);
  } finally {
    rl.close();
  }
}
