import { existsSync } from "node:fs";
import { join } from "node:path";
import { readDotEnv } from "./dotenv.js";

export type BootstrapEnvOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function loadJuiceEnv(options: BootstrapEnvOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const originalKeys = new Set(Object.keys(env));

  for (const file of [join(cwd, ".env"), join(cwd, ".env.local")]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(readDotEnv(file))) {
      if (key.startsWith("JUICE_")) {
        console.warn(`Ignoring ${key} from ${file}; Juice control-plane variables must come from the real environment or flags.`);
        continue;
      }
      if (!originalKeys.has(key)) env[key] = value;
    }
  }
}
