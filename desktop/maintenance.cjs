const path = require("node:path");
const { app, safeStorage } = require("electron");
const runtime = require("./runtime.cjs");

app.setName("Millplan");
const desktopPaths = runtime.getDesktopPaths({
  projectRoot: path.join(__dirname, ".."), resourcesRoot: process.resourcesPath, packaged: app.isPackaged,
});
require("node:fs").mkdirSync(desktopPaths.dataRoot, { recursive: true });
app.setPath("userData", desktopPaths.dataRoot);

async function main() {
  const request = runtime.parseDesktopArguments(process.argv.slice(1));
  if (!request.backupOutput) throw new Error("Maintenance mode requires --backup-output <absolute path>.");
  await app.whenReady();
  const paths = desktopPaths;
  let config;
  let password;
  let database;
  try {
    config = await runtime.loadDesktopConfig(paths, safeStorage);
    password = await runtime.loadDatabaseSecretAsync(config, safeStorage, paths);
    database = await runtime.ensureDatabase(paths, config, password);
    await runtime.createDatabaseBackup(paths, config, password, request.backupOutput);
    await runtime.writeBackupStatus(request.backupOutput, { ok: true });
  } catch (error) {
    await runtime.writeBackupStatus(request.backupOutput, { ok: false, error }).catch(() => undefined);
    throw error;
  } finally {
    if (database?.started && config && password) await runtime.stopDatabase(paths, config, password).catch(() => undefined);
  }
}

main().then(() => app.quit(), error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Maintenance failed."}\n`);
  process.exitCode = 1;
  app.quit();
});
