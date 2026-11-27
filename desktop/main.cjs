const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, dialog, Menu, nativeImage, Notification, safeStorage, session, shell, Tray } = require("electron");
const runtime = require("./runtime.cjs");

app.setName("Millplan");
const paths = runtime.getDesktopPaths({
  projectRoot: path.join(__dirname, ".."),
  resourcesRoot: process.resourcesPath,
  packaged: app.isPackaged,
});
fs.mkdirSync(paths.dataRoot, { recursive: true });
app.setPath("userData", paths.dataRoot);

let initialArguments;
try {
  initialArguments = runtime.parseDesktopArguments(process.argv.slice(1));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  app.exit(2);
}

if (!app.requestSingleInstanceLock({ request: initialArguments })) {
  app.quit();
} else {
  runOwnerInstance().catch(async error => {
    await logError("Unrecoverable desktop error", error);
    if (app.isReady()) dialog.showErrorBox("Millplan could not start", publicMessage(error));
    process.exitCode = 1;
    app.quit();
  });
}

async function runOwnerInstance() {
  let config;
  let password;
  let server;
  let database;
  let mainWindow;
  let startupWindow;
  let tray;
  let quitting = false;
  let shutdownFinished = false;
  let startupFinished = false;
  let backupQueue = Promise.resolve();

  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    let request;
    try {
      request = additionalData?.request
        ? runtime.parseDesktopRequest(additionalData.request)
        : runtime.parseDesktopArguments(argv.slice(1));
    }
    catch (error) { void logError("Invalid secondary-instance request", error); return; }
    if (request.quit) {
      void requestFullQuit();
    } else if (request.backupOutput) {
      backupQueue = backupQueue
        .catch(() => undefined)
        .then(() => performBackup(request.backupOutput))
        .catch(error => logError("Forwarded database backup failed", error));
    } else if (!request.hidden) {
      showMainWindow();
    }
  });

  app.on("before-quit", event => {
    if (shutdownFinished) return;
    event.preventDefault();
    void requestFullQuit();
  });
  app.on("activate", () => showMainWindow());
  await app.whenReady();

  if (initialArguments.quit) {
    shutdownFinished = true;
    app.quit();
    return;
  }
  configureSessionSecurity();

  if (initialArguments.backupOutput) {
    try {
      await prepareDatabase();
      await performBackup(initialArguments.backupOutput);
    } catch (error) {
      await runtime.writeBackupStatus(initialArguments.backupOutput, { ok: false, error }).catch(() => undefined);
      await logError("Database backup failed", error);
      process.exitCode = 1;
    } finally {
      await shutdownRuntime({ stopAdopted: false });
      shutdownFinished = true;
      app.quit();
    }
    return;
  }

  startupWindow = createStartupWindow();
  while (!startupFinished && !quitting) {
    try {
      await prepareDatabase();
      await runtime.assertPortAvailable(config.httpPort, "HTTP");
      setServerEnvironment(config, password);
      const serverModule = require(path.join(paths.serverDir, "index.cjs"));
      server = await serverModule.startServer();
      mainWindow = createMainWindow(config.httpPort);
      tray = createTray();
      await mainWindow.loadURL(`http://127.0.0.1:${config.httpPort}/`);
      startupFinished = true;
      startupWindow?.destroy();
      startupWindow = undefined;
      if (!initialArguments.hidden) mainWindow.show();
    } catch (error) {
      await logError("Desktop startup failed", error);
      await shutdownRuntime({ stopAdopted: false });
      const choice = await dialog.showMessageBox(startupWindow, {
        type: "error",
        title: "Millplan could not start",
        message: "Millplan could not start its local services.",
        detail: publicMessage(error),
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (choice.response !== 0) await requestFullQuit();
    }
  }

  function showMainWindow() {
    if (!startupFinished || !mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  async function prepareDatabase() {
    config = await runtime.loadDesktopConfig(paths, safeStorage);
    password = await runtime.loadDatabaseSecretAsync(config, safeStorage, paths);
    database = await runtime.ensureDatabase(paths, config, password);
  }

  async function performBackup(outputFile) {
    try {
      if (!config || !password) await prepareDatabase();
      const output = await runtime.createDatabaseBackup(paths, config, password, outputFile);
      await runtime.writeBackupStatus(outputFile, { ok: true });
      return output;
    } catch (error) {
      await runtime.writeBackupStatus(outputFile, { ok: false, error }).catch(() => undefined);
      await logError("Database backup failed", error);
      throw error;
    }
  }

  function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "icon.ico"));
    const item = new Tray(icon);
    item.setToolTip("Millplan");
    item.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Millplan", click: showMainWindow },
      { label: "Back up database…", click: () => void chooseDatabaseBackup() },
      { label: "Open backups folder", click: () => void shell.openPath(path.join(paths.dataRoot, "backups")) },
      { type: "separator" },
      { label: "Quit", click: () => void requestFullQuit() },
    ]));
    item.on("double-click", showMainWindow);
    return item;
  }

  async function chooseDatabaseBackup() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const selection = owner
      ? await dialog.showSaveDialog(owner, {
        title: "Back up Millplan database",
        defaultPath: path.join(paths.databaseBackupDir, `millplan-database-${stamp}.dump`),
        filters: [{ name: "PostgreSQL database backup", extensions: ["dump"] }],
      })
      : await dialog.showSaveDialog({
        title: "Back up Millplan database",
        defaultPath: path.join(paths.databaseBackupDir, `millplan-database-${stamp}.dump`),
        filters: [{ name: "PostgreSQL database backup", extensions: ["dump"] }],
      });
    if (selection.canceled || !selection.filePath) return;
    backupQueue = backupQueue
      .catch(() => undefined)
      .then(() => performBackup(selection.filePath))
      .then(() => notifyUser("Database backup complete", `Saved to ${selection.filePath}`))
      .catch(error => notifyUser("Database backup failed", publicMessage(error), true));
    await backupQueue;
  }

  async function requestFullQuit() {
    if (quitting) return;
    quitting = true;
    tray?.destroy();
    tray = undefined;
    startupWindow?.hide();
    mainWindow?.hide();
    await backupQueue.catch(() => undefined);
    await shutdownRuntime();
    shutdownFinished = true;
    app.quit();
  }

  async function shutdownRuntime({ stopAdopted = true } = {}) {
    let failure;
    if (server) {
      try { await server.close(); } catch (error) { failure = error; }
      server = undefined;
    }
    if (config && password && (stopAdopted || database?.started)) {
      try { await runtime.stopDatabase(paths, config, password); } catch (error) { failure ||= error; }
    }
    database = undefined;
    if (failure) await logError("Desktop shutdown was incomplete", failure);
  }

  function createMainWindow(port) {
    const allowedOrigin = `http://127.0.0.1:${port}`;
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1040,
      minHeight: 700,
      show: false,
      title: "Millplan",
      icon: path.join(__dirname, "assets", "icon.ico"),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      try { if (new URL(url).origin !== allowedOrigin) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.on("close", async event => {
      if (quitting) return;
      event.preventDefault();
      window.hide();
      if (config.closeToTrayExplained) return;
      config.closeToTrayExplained = true;
      await runtime.writeDesktopConfig(paths, config).catch(error => logError("Could not save tray preference", error));
      await dialog.showMessageBox({
        type: "info",
        title: "Millplan is still running",
        message: "Millplan was minimized to the notification area.",
        detail: "Its local services and any active tunnel remain available. Use Quit from the tray menu to stop Millplan completely.",
        buttons: ["OK"],
        noLink: true,
      });
    });
    return window;
  }
}

function configureSessionSecurity() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (_event, item) => {
    item.pause();
    const filename = path.basename(item.getFilename());
    void dialog.showSaveDialog({
      title: "Save Millplan export",
      defaultPath: path.join(app.getPath("downloads"), filename),
    }).then(selection => {
      if (selection.canceled || !selection.filePath) {
        item.cancel();
        return;
      }
      item.setSavePath(selection.filePath);
      item.once("done", (_downloadEvent, state) => {
        if (state === "completed") notifyUser("Export saved", `Saved to ${selection.filePath}`);
        else if (state !== "cancelled") notifyUser("Export failed", `The export ended with status: ${state}.`, true);
      });
      item.resume();
    }).catch(error => {
      item.cancel();
      notifyUser("Export failed", publicMessage(error), true);
    });
  });
}

function notifyUser(title, body, error = false) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  } else if (error) {
    dialog.showErrorBox(title, body);
  }
}

function createStartupWindow() {
  const window = new BrowserWindow({
    width: 460, height: 250, resizable: false, maximizable: false, minimizable: false,
    show: true, frame: false, alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Starting Millplan</title><style>body{margin:0;background:#f6f4ed;color:#17352c;font:16px system-ui;display:grid;place-items:center;height:100vh}main{text-align:center}h1{font-size:27px;margin:0 0 12px}p{color:#557269;margin:0}.dot{margin:24px auto 0;width:34px;height:34px;border:4px solid #d8e1dc;border-top-color:#26745d;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style><main><h1>Millplan</h1><p>Starting local database and workspace…</p><div class="dot"></div></main>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return window;
}

function setServerEnvironment(config, password) {
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(config.httpPort);
  process.env.PUBLIC_PORT = String(config.httpPort);
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(config.database.user)}:${encodeURIComponent(password)}@127.0.0.1:${config.postgresPort}/${encodeURIComponent(config.database.name)}`;
  process.env.DIST_DIR = paths.uiDir;
  process.env.MIGRATIONS_DIR = path.join(paths.serverDir, "migrations");
  process.env.ALLOWED_ORIGINS = config.allowedOrigins.join(",");
  process.env.AUTOMATIC_BACKUP_ENABLED = "true";
  process.env.AUTOMATIC_BACKUP_DIR = paths.automaticBackupDir;
  process.env.AUTOMATIC_BACKUP_INTERVAL_HOURS ||= "24";
  process.env.AUTOMATIC_BACKUP_RETENTION_COUNT ||= "14";
}

async function logError(context, error) {
  const message = `[${new Date().toISOString()}] ${context}: ${publicMessage(error)}\n`;
  await fsp.mkdir(paths.logsDir, { recursive: true }).catch(() => undefined);
  await fsp.appendFile(paths.logFile, message, "utf8").catch(() => undefined);
}

function publicMessage(error) {
  const message = error instanceof Error ? error.message : "Unknown error.";
  return message.replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://[redacted]@").slice(0, 2_000);
}
