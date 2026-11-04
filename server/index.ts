import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db";
import { runMigrations } from "./migrate";
import { createDefaultSettings } from "../src/domain/defaults";
import { WorkspaceStore } from "./store";
import { AutomaticBackupService } from "./automaticBackup";

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  pool.on("error", () => process.stderr.write("PostgreSQL pool reported an idle connection error.\n"));
  let server;
  let automaticBackup: AutomaticBackupService | undefined;
  try {
    await runMigrations(pool);
    const store = new WorkspaceStore(pool);
    await store.initialize(createDefaultSettings());
    automaticBackup = new AutomaticBackupService(config.automaticBackup, { exportBackup: () => store.getPortableBackup() });
    await automaticBackup.start();
    server = createServer(createApp({
      store,
      hostPorts: config.hostPorts,
      distDir: config.distDir,
      allowedOrigins: config.allowedOrigins,
      automaticBackupStatus: () => automaticBackup!.getStatus(),
    }));
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(config.port, config.host, () => {
        server!.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await automaticBackup?.close();
    await pool.end();
    throw error;
  }
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      catch (error) { failure = error; }
      try { await automaticBackup!.close(); }
      catch (error) { failure ??= error; }
      try { await pool.end(); }
      catch (error) { failure ??= error; }
      if (failure) throw failure;
    },
  };
}

async function main(): Promise<void> {
  const running = await startServer();
  process.stdout.write(`Pellet Planning Dashboard listening on ${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8080"}.\n`);
  const shutdown = async () => {
    try { await running.close(); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Server failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
