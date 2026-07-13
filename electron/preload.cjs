const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  getRuntimeInfo: () => ipcRenderer.invoke("desktop:get-runtime-info"),
  createBackup: () => ipcRenderer.invoke("desktop:create-backup"),
  openBackupFolder: () => ipcRenderer.invoke("desktop:open-backup-folder"),
  configureTailscale: () => ipcRenderer.invoke("desktop:configure-tailscale"),
  getAutoStart: () => ipcRenderer.invoke("desktop:get-auto-start"),
  setAutoStart: (enabled) => ipcRenderer.invoke("desktop:set-auto-start", Boolean(enabled))
});
