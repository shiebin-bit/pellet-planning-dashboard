const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const runtime = require("../desktop/runtime.cjs");
const databasePassword = "A9vK2xQ7mR4tY8pL6nD3sF5hJ1cB0wZqE7uI9oP2";

const safeStorage = {
  isEncryptionAvailable: () => true,
  isAsyncEncryptionAvailable: async () => true,
  encryptString: value => Buffer.from(`protected:${value}`, "utf8"),
  encryptStringAsync: async value => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: value => value.toString("utf8").replace(/^protected:/, ""),
  decryptStringAsync: async value => ({ shouldReEncrypt: false, result: value.toString("utf8").replace(/^protected:/, "") }),
};

test("empty first launch creates stable encrypted configuration outside the install", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "millplan-desktop-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = runtime.getDesktopPaths({ dataRoot: root, projectRoot: path.resolve(__dirname, "..") });
  const first = await runtime.loadDesktopConfig(paths, safeStorage);
  const secret = await runtime.loadDatabaseSecretAsync(first, safeStorage, paths);
  const onDisk = await fs.readFile(paths.configFile, "utf8");
  assert.equal(first.httpPort, 8080);
  assert.equal(first.postgresPort, 5434);
  assert.ok(secret.length >= 40);
  assert.ok(!onDisk.includes(secret));
  const second = await runtime.loadDesktopConfig(paths, safeStorage);
  assert.equal(await runtime.loadDatabaseSecretAsync(second, safeStorage, paths), secret);
});

test("an existing cluster without its credential is never assigned a replacement password", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "millplan-desktop-orphan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = runtime.getDesktopPaths({ dataRoot: root, projectRoot: path.resolve(__dirname, "..") });
  await fs.mkdir(paths.postgresDataDir, { recursive: true });
  await fs.writeFile(path.join(paths.postgresDataDir, "PG_VERSION"), "16\n");
  await assert.rejects(runtime.loadDesktopConfig(paths, safeStorage), /existing PostgreSQL data directory/);
  await assert.rejects(fs.access(paths.configFile));
});

test("empty or low-entropy decrypted credentials fail before any PostgreSQL tool", () => {
  assert.throws(() => runtime.assertDatabasePassword(""), /empty, truncated/);
  assert.throws(() => runtime.assertDatabasePassword("a".repeat(64)), /high-entropy/);
});

test("database stop and restart reuse the same cluster and create the application database once", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "millplan-desktop-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = runtime.getDesktopPaths({ dataRoot: root, projectRoot: path.resolve(__dirname, "..") });
  await fs.mkdir(paths.postgresDataDir, { recursive: true });
  await fs.writeFile(path.join(paths.postgresDataDir, "PG_VERSION"), "16\n");
  await fs.mkdir(paths.logsDir, { recursive: true });
  const config = runtime.defaultConfig();
  let running = false;
  let databaseCreated = false;
  const calls = [];
  const runResult = async (_file, args) => ({ code: args[0] === "status" && running ? 0 : 3, stdout: "", stderr: "" });
  const run = async (file, args) => {
    calls.push({ tool: path.basename(file, ".exe"), args });
    if (args[0] === "start") { running = true; return ""; }
    if (args[0] === "stop") { running = false; return ""; }
    if (path.basename(file, ".exe") === "createdb") { databaseCreated = true; return ""; }
    const query = args[args.indexOf("-c") + 1];
    if (query.includes("current_user, current_setting")) return `millplan\t${paths.postgresDataDir}\n`;
    if (query.includes("FROM pg_database")) return databaseCreated ? "1\n" : "\n";
    if (query.includes("current_user, current_database")) return `millplan\tmillplan\t${paths.postgresDataDir}\n`;
    throw new Error(`Unexpected fake command: ${file} ${args.join(" ")}`);
  };
  const options = { run, runResult, portAvailable: async () => true };

  assert.deepEqual(await runtime.startDatabase(paths, config, databasePassword, options), { started: true, adopted: false });
  assert.deepEqual(await runtime.stopDatabase(paths, config, databasePassword, options), { stopped: true });
  assert.deepEqual(await runtime.startDatabase(paths, config, databasePassword, options), { started: true, adopted: false });
  assert.equal(calls.filter(call => call.tool === "createdb").length, 1);
  assert.equal(calls.filter(call => call.args[0] === "start").length, 2);
});

test("occupied PostgreSQL port is refused without stopping or starting an unknown process", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "millplan-desktop-conflict-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = runtime.getDesktopPaths({ dataRoot: root, projectRoot: path.resolve(__dirname, "..") });
  await fs.mkdir(paths.postgresDataDir, { recursive: true });
  await fs.writeFile(path.join(paths.postgresDataDir, "PG_VERSION"), "16\n");
  let invoked = false;
  await assert.rejects(runtime.startDatabase(paths, runtime.defaultConfig(), databasePassword, {
    run: async () => { invoked = true; return ""; },
    runResult: async () => ({ code: 3, stdout: "", stderr: "" }),
    portAvailable: async () => false,
  }), /already used by another process/);
  assert.equal(invoked, false);
});

test("backup CLI parsing and status files expose no credential", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "millplan-desktop-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "database.dump");
  assert.deepEqual(runtime.parseDesktopArguments(["--hidden", "--backup-and-exit", "--backup-output", output]), {
    backup: true, backupOutput: output, hidden: true, quit: false,
  });
  assert.deepEqual(runtime.parseDesktopArguments([`--backup-output=${output}`]), {
    backup: true, backupOutput: output, hidden: false, quit: false,
  });
  assert.deepEqual(runtime.parseDesktopRequest({ backup: true, backupOutput: output, hidden: false, quit: false }), {
    backup: true, backupOutput: output, hidden: false, quit: false,
  });
  const statusFile = await runtime.writeBackupStatus(output, { ok: false, error: new Error("postgresql://user:secret@localhost failed") });
  const status = await fs.readFile(statusFile, "utf8");
  assert.match(status, /\[redacted\]/);
  assert.ok(!status.includes("user:secret"));
});

test("database backup refuses to overwrite an existing file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "millplan-desktop-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "existing.dump");
  await fs.writeFile(output, "keep");
  let invoked = false;
  await assert.rejects(runtime.createDatabaseBackup(
    runtime.getDesktopPaths({ dataRoot: root, projectRoot: path.resolve(__dirname, "..") }),
    runtime.defaultConfig(), databasePassword, output, { run: async () => { invoked = true; } },
  ), /already exists/);
  assert.equal(invoked, false);
  assert.equal(await fs.readFile(output, "utf8"), "keep");
});
