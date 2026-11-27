const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONFIG_VERSION = 1;
const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_POSTGRES_PORT = 5434;

function getDesktopPaths(options = {}) {
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const dataRoot = path.resolve(options.dataRoot || path.join(localAppData, "FFM", "MillPlan"));
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, ".."));
  const resourcesRoot = path.resolve(options.resourcesRoot || projectRoot);
  const packaged = Boolean(options.packaged);
  return {
    dataRoot,
    configDir: path.join(dataRoot, "config"),
    configFile: path.join(dataRoot, "config", "desktop.json"),
    postgresDataDir: path.join(dataRoot, "postgres", "data"),
    automaticBackupDir: path.join(dataRoot, "backups", "automatic"),
    databaseBackupDir: path.join(dataRoot, "backups", "database"),
    logsDir: path.join(dataRoot, "logs"),
    logFile: path.join(dataRoot, "logs", "desktop.log"),
    pgsqlDir: packaged ? path.join(resourcesRoot, "pgsql") : path.join(projectRoot, "output", "vendor", "pgsql"),
    serverDir: packaged ? path.join(resourcesRoot, "server") : path.join(projectRoot, "output", "desktop", "server"),
    uiDir: packaged ? path.join(resourcesRoot, "ui") : path.join(projectRoot, "dist"),
  };
}

async function ensureDesktopDirectories(paths) {
  await Promise.all([
    paths.configDir,
    path.dirname(paths.postgresDataDir),
    paths.automaticBackupDir,
    paths.databaseBackupDir,
    paths.logsDir,
  ].map(directory => fsp.mkdir(directory, { recursive: true })));
  await hardenDataRootAcl(paths);
}

async function hardenDataRootAcl(paths, options = {}) {
  if (process.platform !== "win32") {
    await fsp.chmod(paths.dataRoot, 0o700);
    return;
  }
  const run = options.run || runTool;
  const identity = (await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], { label: "Windows identity lookup" })).trim();
  const match = identity.match(/"(S-\d-(?:\d+-)+\d+)"/i);
  if (!match) throw new Error("Windows account SID could not be determined for the Millplan data directory ACL.");
  await run("icacls.exe", [
    paths.dataRoot,
    "/inheritance:r",
    "/grant:r", `*${match[1]}:(OI)(CI)F`,
    "/grant:r", "*S-1-5-18:(OI)(CI)F",
    "/c",
  ], { label: "Millplan data directory ACL" });
}

async function loadDesktopConfig(paths, safeStorage) {
  await ensureDesktopDirectories(paths);
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(paths.configFile, "utf8"));
  } catch (error) {
    if (error && error.code !== "ENOENT") throw new Error(`Desktop configuration could not be read: ${error.message}`);
  }
  const config = raw === undefined ? defaultConfig() : validateConfig(raw);
  let changed = raw === undefined;
  if (!config.database.encryptedPassword) {
    if (fs.existsSync(path.join(paths.postgresDataDir, "PG_VERSION"))) {
      throw new Error("Millplan found an existing PostgreSQL data directory but no decryptable configured credential. Restore the matching desktop configuration or recover from a verified backup; a new password was not generated.");
    }
    await assertAsyncEncryptionAvailable(safeStorage);
    const password = crypto.randomBytes(32).toString("base64url");
    const encrypted = typeof safeStorage.encryptStringAsync === "function"
      ? await safeStorage.encryptStringAsync(password)
      : safeStorage.encryptString(password);
    config.database.encryptedPassword = encrypted.toString("base64");
    changed = true;
  }
  if (changed) await writeDesktopConfig(paths, config);
  return config;
}

async function writeDesktopConfig(paths, config) {
  const validated = validateConfig(config);
  await fsp.mkdir(paths.configDir, { recursive: true });
  const temporary = `${paths.configFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fsp.rename(temporary, paths.configFile);
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EEXIST") throw error;
    await fsp.rm(paths.configFile, { force: true });
    await fsp.rename(temporary, paths.configFile);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function loadDatabaseSecret(config, safeStorage) {
  assertEncryptionAvailable(safeStorage);
  try {
    const password = safeStorage.decryptString(Buffer.from(config.database.encryptedPassword, "base64"));
    assertDatabasePassword(password);
    return password;
  } catch {
    throw new Error("The database credential cannot be decrypted for this Windows account.");
  }
}

async function loadDatabaseSecretAsync(config, safeStorage, paths) {
  await assertAsyncEncryptionAvailable(safeStorage);
  try {
    if (typeof safeStorage.decryptStringAsync !== "function") return loadDatabaseSecret(config, safeStorage);
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(config.database.encryptedPassword, "base64"));
    assertDatabasePassword(decrypted.result);
    if (decrypted.shouldReEncrypt && paths) {
      config.database.encryptedPassword = (await safeStorage.encryptStringAsync(decrypted.result)).toString("base64");
      await writeDesktopConfig(paths, config);
    }
    return decrypted.result;
  } catch {
    throw new Error("The database credential cannot be decrypted for this Millplan profile and Windows account.");
  }
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    httpPort: DEFAULT_HTTP_PORT,
    postgresPort: DEFAULT_POSTGRES_PORT,
    allowedOrigins: [],
    closeToTrayExplained: false,
    database: { user: "millplan", name: "millplan", encryptedPassword: "" },
  };
}

function validateConfig(value) {
  if (!plainObject(value) || value.version !== CONFIG_VERSION) throw new Error(`desktop.json must use version ${CONFIG_VERSION}.`);
  const allowed = new Set(["version", "httpPort", "postgresPort", "allowedOrigins", "closeToTrayExplained", "database"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`desktop.json contains unsupported field ${key}.`);
  integerPort(value.httpPort, "httpPort");
  integerPort(value.postgresPort, "postgresPort");
  if (value.httpPort === value.postgresPort) throw new Error("httpPort and postgresPort must be different.");
  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.some(origin => typeof origin !== "string" || !origin.trim())) {
    throw new Error("allowedOrigins must be an array of nonblank origins.");
  }
  const origins = value.allowedOrigins.map(normalizeOrigin);
  if (new Set(origins).size !== origins.length) throw new Error("allowedOrigins cannot contain duplicates.");
  if (typeof value.closeToTrayExplained !== "boolean") throw new Error("closeToTrayExplained must be true or false.");
  if (!plainObject(value.database)) throw new Error("database configuration is required.");
  const databaseAllowed = new Set(["user", "name", "encryptedPassword"]);
  for (const key of Object.keys(value.database)) if (!databaseAllowed.has(key)) throw new Error(`database contains unsupported field ${key}.`);
  for (const field of ["user", "name", "encryptedPassword"]) {
    if (typeof value.database[field] !== "string" || (field !== "encryptedPassword" && !/^[a-z][a-z0-9_]{0,62}$/.test(value.database[field]))) {
      throw new Error(`database.${field} is invalid.`);
    }
  }
  if (value.database.encryptedPassword && !/^[A-Za-z0-9+/]+={0,2}$/.test(value.database.encryptedPassword)) {
    throw new Error("database.encryptedPassword is invalid.");
  }
  return {
    version: CONFIG_VERSION,
    httpPort: value.httpPort,
    postgresPort: value.postgresPort,
    allowedOrigins: origins,
    closeToTrayExplained: value.closeToTrayExplained,
    database: { ...value.database },
  };
}

async function initializeDatabase(paths, config, password, options = {}) {
  assertDatabasePassword(password);
  const run = options.run || runTool;
  const versionFile = path.join(paths.postgresDataDir, "PG_VERSION");
  if (fs.existsSync(versionFile)) return { initialized: false };
  if (fs.existsSync(paths.postgresDataDir) && (await fsp.readdir(paths.postgresDataDir)).length) {
    throw new Error(`PostgreSQL data directory is not empty and has no PG_VERSION: ${paths.postgresDataDir}`);
  }
  await fsp.mkdir(paths.postgresDataDir, { recursive: true });
  const passwordFile = path.join(paths.configDir, `.initdb-password-${process.pid}-${crypto.randomUUID()}`);
  await fsp.writeFile(passwordFile, password, { encoding: "utf8", mode: 0o600 });
  try {
    await run(pgTool(paths, "initdb"), [
      "-D", paths.postgresDataDir,
      "-U", config.database.user,
      "--pwfile", passwordFile,
      "--encoding=UTF8",
      "--auth-host=scram-sha-256",
      "--auth-local=scram-sha-256",
    ], { label: "PostgreSQL initialization" });
  } catch (error) {
    await fsp.rm(paths.postgresDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(passwordFile, { force: true }).catch(() => undefined);
  }
  return { initialized: true };
}

async function ensureDatabase(paths, config, password, options = {}) {
  assertDatabasePassword(password);
  await assertPostgresRuntime(paths);
  await initializeDatabase(paths, config, password, options);
  return startDatabase(paths, config, password, options);
}

async function startDatabase(paths, config, password, options = {}) {
  assertDatabasePassword(password);
  const run = options.run || runTool;
  const runResult = options.runResult || runToolResult;
  const portAvailable = options.portAvailable || isPortAvailable;
  const status = await databaseStatus(paths, { runResult });
  if (status.running) {
    await verifyClusterIdentity(paths, config, password, { run });
    await ensureApplicationDatabase(paths, config, password, { run });
    await verifyDatabaseIdentity(paths, config, password, { run });
    return { started: false, adopted: true };
  }
  if (!(await portAvailable(config.postgresPort))) {
    throw new Error(`PostgreSQL port ${config.postgresPort} is already used by another process. Millplan did not stop or replace it.`);
  }
  await run(pgTool(paths, "pg_ctl"), [
    "start", "-D", paths.postgresDataDir,
    "-l", path.join(paths.logsDir, "postgres.log"),
    "-w", "-t", "30",
    "-o", `-p ${config.postgresPort} -h 127.0.0.1`,
  ], { label: "PostgreSQL startup" });
  try {
    await verifyClusterIdentity(paths, config, password, { run });
    await ensureApplicationDatabase(paths, config, password, { run });
    await verifyDatabaseIdentity(paths, config, password, { run });
  } catch (error) {
    await run(pgTool(paths, "pg_ctl"), ["stop", "-D", paths.postgresDataDir, "-m", "fast", "-w", "-t", "30"], { label: "PostgreSQL rollback shutdown" }).catch(() => undefined);
    throw error;
  }
  return { started: true, adopted: false };
}

async function verifyClusterIdentity(paths, config, password, options = {}) {
  const run = options.run || runTool;
  const output = await run(pgTool(paths, "psql"), [
    "-X", "-w", "-A", "-t", "-F", "\t",
    "-h", "127.0.0.1", "-p", String(config.postgresPort),
    "-U", config.database.user, "-d", "postgres",
    "-c", "SELECT current_user, current_setting('data_directory')",
  ], { label: "PostgreSQL cluster identity check", timeoutMs: 15_000, env: { PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" } });
  const fields = output.trim().split("\t");
  if (fields.length !== 2 || fields[0] !== config.database.user || !samePath(fields[1], paths.postgresDataDir)) {
    throw new Error("The PostgreSQL service on the configured port is not Millplan's authenticated data directory.");
  }
}

async function ensureApplicationDatabase(paths, config, password, options = {}) {
  const run = options.run || runTool;
  const exists = await run(pgTool(paths, "psql"), [
    "-X", "-w", "-A", "-t",
    "-h", "127.0.0.1", "-p", String(config.postgresPort),
    "-U", config.database.user, "-d", "postgres",
    "-c", `SELECT 1 FROM pg_database WHERE datname = '${config.database.name}'`,
  ], { label: "Millplan database check", timeoutMs: 15_000, env: { PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" } });
  if (exists.trim() === "1") return { created: false };
  await run(pgTool(paths, "createdb"), [
    "-w",
    "-h", "127.0.0.1", "-p", String(config.postgresPort),
    "-U", config.database.user, config.database.name,
  ], { label: "Millplan database creation", timeoutMs: 30_000, env: { PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" } });
  return { created: true };
}

async function stopDatabase(paths, config, password, options = {}) {
  assertDatabasePassword(password);
  const run = options.run || runTool;
  const runResult = options.runResult || runToolResult;
  const status = await databaseStatus(paths, { runResult });
  if (!status.running) return { stopped: false };
  await verifyClusterIdentity(paths, config, password, { run });
  await run(pgTool(paths, "pg_ctl"), ["stop", "-D", paths.postgresDataDir, "-m", "fast", "-w", "-t", "30"], { label: "PostgreSQL shutdown" });
  return { stopped: true };
}

async function databaseStatus(paths, options = {}) {
  if (!fs.existsSync(path.join(paths.postgresDataDir, "PG_VERSION"))) return { running: false };
  const runResult = options.runResult || runToolResult;
  const result = await runResult(pgTool(paths, "pg_ctl"), ["status", "-D", paths.postgresDataDir], { label: "PostgreSQL status" });
  if (result.code === 0) return { running: true };
  if (result.code === 3 || result.code === 4) return { running: false };
  throw new Error(`PostgreSQL status failed (exit ${result.code}).`);
}

async function verifyDatabaseIdentity(paths, config, password, options = {}) {
  const run = options.run || runTool;
  const output = await run(pgTool(paths, "psql"), [
    "-X", "-w", "-A", "-t", "-F", "\t",
    "-h", "127.0.0.1", "-p", String(config.postgresPort),
    "-U", config.database.user, "-d", config.database.name,
    "-c", "SELECT current_user, current_database(), current_setting('data_directory')",
  ], { label: "PostgreSQL identity check", timeoutMs: 15_000, env: { PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" } });
  const fields = output.trim().split("\t");
  if (fields.length !== 3 || fields[0] !== config.database.user || fields[1] !== config.database.name || !samePath(fields[2], paths.postgresDataDir)) {
    throw new Error("The PostgreSQL service on the configured port is not Millplan's authenticated data directory.");
  }
}

async function createDatabaseBackup(paths, config, password, outputFile, options = {}) {
  assertDatabasePassword(password);
  const run = options.run || runTool;
  const absolute = path.resolve(outputFile);
  if (!path.isAbsolute(outputFile) || path.parse(absolute).root === absolute) throw new Error("Backup output must be an absolute non-root file path.");
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fsp.access(absolute);
    throw new Error(`Backup output already exists: ${absolute}`);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const temporary = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await run(pgTool(paths, "pg_dump"), [
      "-w", "-Fc", "--no-owner", "--no-privileges",
      "-h", "127.0.0.1", "-p", String(config.postgresPort),
      "-U", config.database.user, "-d", config.database.name,
      "-f", temporary,
    ], { label: "Database backup", timeoutMs: 60_000, env: { PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" } });
    const stat = await fsp.stat(temporary);
    if (!stat.isFile() || stat.size === 0) throw new Error("Database backup produced an empty file.");
    await fsp.link(temporary, absolute);
    await fsp.rm(temporary, { force: true });
    return absolute;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseDesktopArguments(argv) {
  const result = { backup: false, backupOutput: undefined, hidden: false, quit: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--hidden") result.hidden = true;
    else if (value === "--quit") result.quit = true;
    else if (value === "--backup-and-exit") result.backup = true;
    else if (value === "--backup-output") {
      const output = argv[index + 1];
      if (!output || output.startsWith("--")) throw new Error("--backup-output requires an absolute file path.");
      result.backupOutput = output;
      result.backup = true;
      index += 1;
    } else if (value.startsWith("--backup-output=")) {
      const output = value.slice("--backup-output=".length);
      if (!output) throw new Error("--backup-output requires an absolute file path.");
      result.backupOutput = output;
      result.backup = true;
    }
  }
  if (result.backup && !result.backupOutput) throw new Error("--backup-and-exit requires --backup-output.");
  if (result.backupOutput && !path.isAbsolute(result.backupOutput)) throw new Error("--backup-output must be an absolute file path.");
  return result;
}

function parseDesktopRequest(value) {
  if (!plainObject(value)) throw new Error("Desktop instance request must be an object.");
  const allowed = new Set(["backup", "backupOutput", "hidden", "quit"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Desktop instance request contains unsupported field ${key}.`);
  if (typeof value.backup !== "boolean" || typeof value.hidden !== "boolean" || typeof value.quit !== "boolean") {
    throw new Error("Desktop instance request flags are invalid.");
  }
  if (value.backupOutput !== undefined && typeof value.backupOutput !== "string") throw new Error("Desktop backup output is invalid.");
  const args = [];
  if (value.hidden) args.push("--hidden");
  if (value.quit) args.push("--quit");
  if (value.backup) args.push("--backup-and-exit");
  if (value.backupOutput !== undefined) args.push(`--backup-output=${value.backupOutput}`);
  return parseDesktopArguments(args);
}

async function writeBackupStatus(outputFile, status) {
  const statusFile = `${path.resolve(outputFile)}.status.json`;
  await fsp.mkdir(path.dirname(statusFile), { recursive: true });
  const temporary = `${statusFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = status.ok
    ? { ok: true, output: path.resolve(outputFile) }
    : { ok: false, error: sanitizeError(status.error) };
  await fsp.writeFile(temporary, `${JSON.stringify(payload)}\n`, "utf8");
  await fsp.rm(statusFile, { force: true });
  await fsp.rename(temporary, statusFile);
  return statusFile;
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : "Unknown backup failure.";
  return message.replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://[redacted]@").slice(0, 1_000);
}

async function assertPostgresRuntime(paths) {
  for (const name of ["initdb", "pg_ctl", "psql", "pg_dump"]) {
    try { await fsp.access(pgTool(paths, name)); }
    catch { throw new Error(`Bundled PostgreSQL tool is missing: ${pgTool(paths, name)}`); }
  }
}

async function assertPortAvailable(port, label = "HTTP") {
  if (!(await isPortAvailable(port))) throw new Error(`${label} port ${port} is already used by another process. Millplan did not stop or replace it.`);
}

function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function runTool(file, args, options = {}) {
  return runToolResult(file, args, options).then(result => {
    if (result.code !== 0) {
      const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
      throw new Error(`${options.label || path.basename(file)} failed (exit ${result.code})${detail ? `: ${detail}` : "."}`);
    }
    return result.stdout;
  });
}

function runToolResult(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${options.label || path.basename(file)} timed out after ${options.timeoutMs || 60_000} ms.`));
    }, options.timeoutMs || 60_000);
    timeout.unref();
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${options.label || path.basename(file)} could not start: ${error.message}`));
    });
    // PostgreSQL's Windows launcher can leave stdout/stderr pipe handles inherited by
    // the detached server. The launcher has completed once it exits; waiting for the
    // Node "close" event would then wait for the server itself to stop.
    child.once("exit", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function pgTool(paths, name) {
  return path.join(paths.pgsqlDir, "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`);
}

function samePath(left, right) {
  const normalize = value => path.resolve(value).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
  return normalize(left) === normalize(right);
}

function normalizeOrigin(origin) {
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    return parsed.origin;
  } catch {
    throw new Error(`Invalid allowedOrigins entry: ${JSON.stringify(origin)}.`);
  }
}

function integerPort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be an integer from 1 to 65535.`);
}

function assertEncryptionAvailable(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows credential encryption is unavailable. Millplan will not store a plaintext database password.");
  }
}

function assertDatabasePassword(password) {
  if (typeof password !== "string" || password.length < 32 || password.length > 1_024 || new Set(password).size < 12 || /[\r\n\0]/.test(password)) {
    throw new Error("The decrypted database credential is empty, truncated, or not a valid high-entropy Millplan password.");
  }
}

async function assertAsyncEncryptionAvailable(safeStorage) {
  if (safeStorage && typeof safeStorage.isAsyncEncryptionAvailable === "function") {
    if (await safeStorage.isAsyncEncryptionAvailable()) return;
    throw new Error("Windows credential encryption is unavailable. Millplan will not store a plaintext database password.");
  }
  assertEncryptionAvailable(safeStorage);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  CONFIG_VERSION,
  DEFAULT_HTTP_PORT,
  DEFAULT_POSTGRES_PORT,
  assertDatabasePassword,
  assertPortAvailable,
  createDatabaseBackup,
  databaseStatus,
  defaultConfig,
  ensureApplicationDatabase,
  ensureDatabase,
  ensureDesktopDirectories,
  getDesktopPaths,
  hardenDataRootAcl,
  initializeDatabase,
  isPortAvailable,
  loadDatabaseSecret,
  loadDatabaseSecretAsync,
  loadDesktopConfig,
  parseDesktopArguments,
  parseDesktopRequest,
  runTool,
  runToolResult,
  startDatabase,
  stopDatabase,
  validateConfig,
  verifyClusterIdentity,
  verifyDatabaseIdentity,
  writeBackupStatus,
  writeDesktopConfig,
};
