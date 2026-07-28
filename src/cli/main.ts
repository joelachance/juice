#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { KEY_COMMANDS, parseArgs } from "./args.js";
import { rootHelpText } from "./help.js";
import { valueAsArgumentError } from "./prompt.js";
import { createInvite, joinAccount, listMembers, listScopes, login } from "./commands/account.js";
import { exportSecrets, getSecret, listSecrets, setSecret, unsetSecret } from "./commands/secrets.js";
import { createMachineToken, revokeToken } from "./commands/tokens.js";

export { juiceLogoRaw, rootHelpText } from "./help.js";

/**
 * Routing, and nothing else.
 *
 * Deliberately does not bootstrap from `.env`. Juice's control plane reads the
 * real environment and flags only, so no file in a repository can change which
 * scope, env, or source a command runs against.
 */
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (args.help || !args.command || args.command === "help") {
    console.log(rootHelpText());
    return 0;
  }
  if (args.remote && args.local) {
    console.error("Pass only one of --remote or --local.");
    return 1;
  }

  switch (args.command) {
    case "auth":
      if (args.subcommand === "login") {
        await login();
        return 0;
      }
      break;
    case "scopes":
      return listScopes(args);
    case "members":
      return args.subcommand === "invite" ? await createInvite(args) : await listMembers(args);
    case "join":
      return await joinAccount(args);
    case "list":
      return await listSecrets(args);
    case "export":
      return await exportSecrets(args);
    case "token":
      if (args.subcommand === "create") {
        await createMachineToken(args);
        return 0;
      }
      if (args.subcommand === "revoke") {
        await revokeToken(args.jti);
        return 0;
      }
      break;
    case "set":
      if (!args.key) break;
      if (args.positionals.length > 2) {
        console.error(valueAsArgumentError(args.key));
        return 1;
      }
      return await setSecret(args.key, args);
    case "get":
      if (!args.key) break;
      return await getSecret(args.key, args);
    case "unset":
      if (!args.key) break;
      return await unsetSecret(args.key, args);
  }

  // A key-taking command with no key: say which argument is missing rather than
  // dumping the whole help screen and leaving the reader to diff it.
  if (KEY_COMMANDS.has(args.command)) {
    console.error(`\`juice ${args.command}\` needs a KEY.`);
    console.error("");
    console.error(`  juice ${args.command} MY_KEY --scope <name>${args.command === "set" ? " --stdin" : ""}`);
    return 1;
  }

  console.error(rootHelpText());
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
