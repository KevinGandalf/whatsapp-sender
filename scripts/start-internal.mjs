#!/usr/bin/env node
/**
 * Start the built app for an internal server.
 * Bind stays on 127.0.0.1 unless HOST is set. Put HTTPS in front.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel/output");
const entry = join(out, "functions/__server.func/index.mjs");
const missing = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"].filter(
  (key) => !process.env[key]?.trim(),
);

if (!existsSync(entry)) {
  console.error("Build fehlt. Zuerst im Projektordner: npm run build");
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`Umgebungsvariablen fehlen: ${missing.join(", ")}`);
  process.exit(1);
}
if (!process.env.WASENDER_PULSE_SECRET?.trim()) {
  console.warn("WASENDER_PULSE_SECRET ist leer. Regeltermine laufen nur, solange jemand Wasender im Browser offen hat.");
}

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = process.env.PORT?.trim() || "3000";
const child = spawn(
  process.execPath,
  [
    join(root, "node_modules/srvx/bin/srvx.mjs"),
    "--prod",
    "--host",
    host,
    "--port",
    port,
    "--static",
    join(out, "static"),
    entry,
  ],
  { stdio: "inherit", cwd: out, env: process.env },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
