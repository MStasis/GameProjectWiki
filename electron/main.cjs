const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } = require("electron");

const { createBackup, pruneBackups } = require("./backup-service.cjs");
const { createSyncServer } = require("./sync-server.cjs");
const { SyncStore } = require("./sync-store.cjs");

const execFileAsync = promisify(execFile);
const SERVER_PORT = 8765;
const LOGIN_ITEM_ARGUMENTS = ["--hidden"];

let mainWindow;
let tray;
let runtime;
let quitting = false;

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function assertTrustedIpcSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || "";
  if (!runtime?.server?.localUrl || !sameOrigin(senderUrl, runtime.server.localUrl)) {
    throw new Error("Untrusted desktop bridge caller");
  }
}

function applicationIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "..", "build", "icon.png");
}

function randomSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

async function loadCredentials(dataDirectory) {
  const credentialsPath = path.join(dataDirectory, "sync-credentials.json");
  try {
    return JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const credentials = {
      username: "wiki-sync",
      password: randomSecret(),
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(credentialsPath, JSON.stringify(credentials, null, 2), { encoding: "utf8", mode: 0o600 });
    return credentials;
  }
}

function tailscaleExecutable() {
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe"),
    "tailscale.exe"
  ];
  return candidates;
}

async function runTailscale(args) {
  let lastError;
  for (const executable of tailscaleExecutable()) {
    try {
      return await execFileAsync(executable, args, { windowsHide: true, timeout: 15000 });
    } catch (error) {
      lastError = error;
      if (error.code !== "ENOENT") break;
    }
  }
  throw lastError || new Error("Tailscale is not installed");
}

async function configureTailscaleServe() {
  await runTailscale(["serve", "--bg", "--yes", `http://127.0.0.1:${SERVER_PORT}`]);
  const { stdout } = await runTailscale(["status", "--json"]);
  const status = JSON.parse(stdout);
  const dnsName = String(status.Self?.DNSName || "").replace(/\.$/, "");
  if (!dnsName) throw new Error("Tailscale DNS name is unavailable");
  return `https://${dnsName}`;
}

function tailscaleActivationUrl(error) {
  const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
  for (const match of output.matchAll(/https:\/\/[^\s<>'"]+/g)) {
    try {
      const candidate = new URL(match[0].replace(/[),.;]+$/, ""));
      if (candidate.hostname === "login.tailscale.com") return candidate.href;
    } catch {
      // Ignore malformed diagnostic URLs.
    }
  }
  return "";
}

function createWindow(localUrl, { startHidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#071018",
    icon: applicationIconPath(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (!startHidden) mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const keepOnLocalOrigin = (event, url) => {
    if (!sameOrigin(url, localUrl)) event.preventDefault();
  };
  mainWindow.webContents.on("will-navigate", keepOnLocalOrigin);
  mainWindow.webContents.on("will-redirect", keepOnLocalOrigin);
  void mainWindow.loadURL(localUrl);
}

function createTray() {
  const icon = nativeImage.createFromPath(applicationIconPath());
  if (icon.isEmpty()) throw new Error("The packaged application icon could not be loaded");
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Title Placeholder Wiki");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "위키 열기", click: () => mainWindow?.show() },
    { label: "지금 백업", click: () => void safeBackgroundBackup("tray", true) },
    { type: "separator" },
    {
      label: "종료",
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("double-click", () => mainWindow?.show());
}

async function createAndNotifyBackup(reason = "manual") {
  const filePath = await createBackup(runtime.store, runtime.backupDirectory, reason);
  await pruneBackups(runtime.backupDirectory, 30);
  return filePath;
}

async function safeBackgroundBackup(reason, notifyOnFailure = false) {
  try {
    return await createAndNotifyBackup(reason);
  } catch (error) {
    console.error(`Backup failed (${reason}):`, error);
    if (notifyOnFailure) dialog.showErrorBox("Title Placeholder Wiki", `백업을 만들지 못했습니다.\n${error.message}`);
    return null;
  }
}

function registerIpc() {
  ipcMain.handle("desktop:get-runtime-info", async (event) => {
    assertTrustedIpcSender(event);
    return {
      isDesktop: true,
      localUrl: runtime.server.localUrl,
      port: SERVER_PORT,
      username: runtime.credentials.username,
      password: runtime.credentials.password,
      tailscaleUrl: runtime.tailscaleUrl || "",
      dataDirectory: runtime.dataDirectory,
      backupDirectory: runtime.backupDirectory,
      store: runtime.store.getStatus()
    };
  });
  ipcMain.handle("desktop:create-backup", (event) => {
    assertTrustedIpcSender(event);
    return createAndNotifyBackup("manual");
  });
  ipcMain.handle("desktop:open-backup-folder", (event) => {
    assertTrustedIpcSender(event);
    return shell.openPath(runtime.backupDirectory);
  });
  ipcMain.handle("desktop:configure-tailscale", async (event) => {
    assertTrustedIpcSender(event);
    try {
      runtime.tailscaleUrl = await configureTailscaleServe();
      return { ok: true, url: runtime.tailscaleUrl };
    } catch (error) {
      const activationUrl = tailscaleActivationUrl(error);
      if (activationUrl) void shell.openExternal(activationUrl);
      return {
        ok: false,
        error: error.message,
        details: [error.stdout, error.stderr].filter(Boolean).join("\n").slice(0, 4000),
        activationUrl
      };
    }
  });
  ipcMain.handle("desktop:get-auto-start", (event) => {
    assertTrustedIpcSender(event);
    return app.getLoginItemSettings({ args: LOGIN_ITEM_ARGUMENTS }).openAtLogin;
  });
  ipcMain.handle("desktop:set-auto-start", (event, enabled) => {
    assertTrustedIpcSender(event);
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: LOGIN_ITEM_ARGUMENTS });
    return app.getLoginItemSettings({ args: LOGIN_ITEM_ARGUMENTS }).openAtLogin;
  });
}

async function bootstrap() {
  const dataDirectory = path.join(app.getPath("userData"), "wiki-data");
  const backupDirectory = path.join(app.getPath("documents"), "Title Placeholder Wiki", "Backups");
  await fs.mkdir(dataDirectory, { recursive: true });
  const store = new SyncStore(dataDirectory);
  await store.init();
  const credentials = await loadCredentials(dataDirectory);
  const distDirectory = path.join(__dirname, "..", "dist");
  const server = await createSyncServer({ store, distDirectory, credentials, port: SERVER_PORT });
  runtime = { dataDirectory, backupDirectory, store, credentials, server, tailscaleUrl: "" };
  registerIpc();
  createWindow(server.localUrl, { startHidden: process.argv.includes("--hidden") });
  createTray();
  await safeBackgroundBackup("startup");
  setInterval(() => void safeBackgroundBackup("scheduled"), 24 * 60 * 60 * 1000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap).catch((error) => {
    dialog.showErrorBox("Title Placeholder Wiki", error.message);
    app.quit();
  });
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  // Keep the sync host running in the tray on Windows.
});
