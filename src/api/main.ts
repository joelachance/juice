#!/usr/bin/env node
import { loadJuiceEnv } from "../local/bootstrap-env.js";
import { createJuiceServer } from "./server.js";

loadJuiceEnv();

const port = Number.parseInt(process.env.PORT || "8787", 10);
const host = process.env.HOST || "0.0.0.0";

const server = createJuiceServer();

server.listen(port, host, () => {
  console.log(`Juice API listening on http://${host}:${port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down Juice API.`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    process.exit();
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
