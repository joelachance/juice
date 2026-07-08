import { join } from "node:path";
import { getToken } from "../auth/token-store.js";
import { resolveProject, resolveJuiceEnv, isLocalMode } from "../config/project.js";
import { apiBase, requestJson } from "../http/client.js";
import { readDotEnv } from "../local/dotenv.js";
import { hasEnvDrift } from "../local/state.js";

export type JuiceGetOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

let warnedAboutDrift = false;

export const juice = {
  async get(key: string, options: JuiceGetOptions = {}): Promise<string> {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const { project, root } = resolveProject(cwd, env);
    const envName = resolveJuiceEnv(env);

    if (isLocalMode(env)) {
      const envFile = join(root, ".env");
      if (!warnedAboutDrift && hasEnvDrift(root, envFile)) {
        warnedAboutDrift = true;
        console.warn(".env changed outside Juice. Use juice set KEY to add or update secrets.");
      }
      const value = readDotEnv(envFile)[key];
      if (value === undefined) throw new Error(`Missing local secret: ${key}`);
      return value;
    }

    const token = getToken(env);
    if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before reading remote secrets.");
    const path = `/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(envName)}/secrets/${encodeURIComponent(key)}`;
    const response = await requestJson<{ value: string }>(`${apiBase(env)}${path}`, {
      method: "GET",
      token
    });
    return response.value;
  }
};

export default juice;
