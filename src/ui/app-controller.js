import PouchDB from "pouchdb-browser";
import DOMPurify from "dompurify";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { HttpSyncTransport, SyncController, WikiRepository } from "../lib/index.js";
import { renderApp, safeExternalUrl, sanitizeUserHtml } from "./templates.js";

const DATABASE_NAME = "title-placeholder-wiki";
const SETTINGS_KEY = "title-placeholder-wiki:sync-settings:v1";
const INSTALL_DISMISSED_KEY = "title-placeholder-wiki:install-dismissed";
const AUTOSAVE_DELAY = 850;

const DEFAULT_SYNC_STATUS = Object.freeze({
  state: "idle",
  running: false,
  direction: null,
  lastChangedAt: null,
  lastSyncedAt: null,
  error: null,
});

function detectPlatform() {
  const capacitor = window.Capacitor;
  const nativePlatform = capacitor?.getPlatform?.();
  const isCapacitorNative = Boolean(capacitor?.isNativePlatform?.());
  const isDesktop = Boolean(window.desktopBridge || /\bElectron\b/i.test(navigator.userAgent));
  if (isDesktop) {
    return {
      kind: "desktop",
      label: "Windows PC",
      shortLabel: "WINDOWS",
      defaultDeviceName: "집 PC",
      isNative: true,
    };
  }
  if (isCapacitorNative || nativePlatform === "android" || /\bAndroid\b/i.test(navigator.userAgent)) {
    return {
      kind: "android",
      label: "Android 휴대폰",
      shortLabel: "ANDROID",
      defaultDeviceName: "내 휴대폰",
      isNative: Boolean(isCapacitorNative),
    };
  }
  return {
    kind: "web",
    label: "웹 브라우저",
    shortLabel: "WEB",
    defaultDeviceName: "웹 브라우저",
    isNative: false,
  };
}

function readSettings(platform) {
  const defaults = {
    remoteUrl: "",
    username: "wiki-sync",
    password: "",
    deviceName: platform.defaultDeviceName,
    autoSync: true,
    archiveId: "LOCAL-PRIMARY",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    return saved && typeof saved === "object" ? { ...defaults, ...saved } : defaults;
  } catch {
    return defaults;
  }
}

function persistSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "") || "home";
  const [path, queryString = ""] = raw.split("?", 2);
  const parts = path.split("/").filter(Boolean);
  const allowed = new Set(["home", "folder", "page", "edit", "search", "structure", "trash", "revisions", "settings"]);
  const name = allowed.has(parts[0]) ? parts[0] : "not-found";
  return {
    name,
    params: { id: parts[1] ? decodeURIComponent(parts[1]) : "" },
    query: new URLSearchParams(queryString),
  };
}

function canonicalBlockType(type) {
  const value = String(type || "rich_text").toLowerCase();
  if (value === "text" || value === "richtext") return "rich_text";
  if (value === "sheet" || value === "googlesheet") return "google_sheet";
  return value;
}

function uiBlockType(type) {
  const value = canonicalBlockType(type);
  if (value === "rich_text") return "text";
  if (value === "google_sheet") return "sheet";
  return value;
}

function normalizeBlock(block) {
  if (!block) return block;
  return {
    ...block,
    type: canonicalBlockType(block.type || block.blockType),
    blockType: uiBlockType(block.type || block.blockType),
    data: block.data && typeof block.data === "object" ? { ...block.data } : {},
  };
}

function sortByOrder(items = []) {
  return [...items].sort((left, right) => {
    const a = String(left.orderKey || "");
    const b = String(right.orderKey || "");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function normalizeServerUrl(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const href = safeExternalUrl(input);
  if (!href) throw new TypeError("유효한 https PC 주소를 입력하세요.");
  const url = new URL(href);
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError("비밀번호 보호를 위해 Tailscale https 주소를 사용하세요. http는 이 PC의 localhost만 허용됩니다.");
  }
  url.pathname = url.pathname.replace(/\/(?:api\/sync(?:\/(?:push|pull|status))?)?\/?$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function createSyncTransport(config, { onCheckpoint } = {}) {
  const baseUrl = normalizeServerUrl(config.remoteUrl);
  if (!baseUrl) throw new TypeError("유효한 http 또는 https PC 주소를 입력하세요.");
  const transport = new HttpSyncTransport({
    baseUrl,
    username: config.username,
    password: config.password,
    timeoutMs: 5 * 60 * 1000,
  });

  return {
    push: (changes, options) => transport.push(changes, options),
    async pull(checkpoint, { signal, limit = 3 } = {}) {
      const result = await transport.pull(checkpoint, {
        signal,
        limit: Math.min(3, Math.max(1, Number(limit) || 3)),
      });
      if (result?.checkpoint !== undefined) await onCheckpoint?.(result.checkpoint);
      return result;
    },
  };
}

export class RepositoryAdapter {
  constructor({ databaseName = DATABASE_NAME, onSyncStatus } = {}) {
    this.db = new PouchDB(databaseName, { auto_compaction: true });
    this.repository = new WikiRepository(this.db, {
      sanitizeHtml: (html) => DOMPurify.sanitize(String(html || ""), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
        FORBID_ATTR: ["srcdoc"],
      }),
    });
    this.syncController = null;
    this.syncUnsubscribe = null;
    this.onSyncStatus = typeof onSyncStatus === "function" ? onSyncStatus : () => {};
    this.syncConfig = null;
    this.pendingCheckpoint = undefined;
    this.syncNowPromise = null;
  }

  async init() {
    return this.repository.init();
  }

  async listNodes(includeDeleted = false) {
    return this.repository.listNodes({ includeDeleted });
  }

  async getNode(id, includeDeleted = false) {
    return this.repository.getNode(id, { includeDeleted });
  }

  async createNode(input) {
    return this.repository.createNode(input);
  }

  async updateNode(id, patch) {
    return this.repository.updateNode(id, patch);
  }

  async deleteNode(id) {
    return this.repository.deleteNode(id);
  }

  async restoreNode(id) {
    return this.repository.restoreNode(id);
  }

  async listBlocks(nodeId, includeDeleted = false) {
    return (await this.repository.listBlocks(nodeId, { includeDeleted })).map(normalizeBlock);
  }

  async createBlock(nodeId, input) {
    return normalizeBlock(await this.repository.createBlock(nodeId, {
      ...input,
      type: canonicalBlockType(input.type || input.blockType),
    }));
  }

  async updateBlock(id, patch) {
    return normalizeBlock(await this.repository.updateBlock(id, {
      ...patch,
      ...(patch.type || patch.blockType ? { type: canonicalBlockType(patch.type || patch.blockType) } : {}),
    }));
  }

  async deleteBlock(id) {
    return this.repository.deleteBlock(id);
  }

  async moveNode(id, position) {
    return this.repository.updateNode(id, position);
  }

  async moveBlock(id, position) {
    return normalizeBlock(await this.repository.updateBlock(id, position));
  }

  async search(query) {
    return this.repository.search(query || "");
  }

  async saveRevision(nodeId, reason) {
    return this.repository.saveRevision(nodeId, { reason });
  }

  async listRevisions(nodeId) {
    return this.repository.listRevisions(nodeId);
  }

  async restoreRevision(revisionId) {
    return this.repository.restoreRevision(revisionId);
  }

  async addAsset(nodeId, file, metadata = {}) {
    return this.repository.addAsset({ nodeId, altText: metadata.alt || "", caption: metadata.caption || "" }, {
      data: await file.arrayBuffer(),
      contentType: file.type,
      filename: file.name,
    });
  }

  async getAsset(id) {
    return this.repository.getAsset(id, { withData: true });
  }

  async listAssets() {
    return typeof this.repository.listAssets === "function" ? this.repository.listAssets() : [];
  }

  async getPendingCount() {
    if (typeof this.repository.getPendingChanges !== "function") return 0;
    return (await this.repository.getPendingChanges({ limit: 100, includeAttachments: false })).length;
  }

  async listConflicts() {
    return this.repository.listConflicts();
  }

  async resolveConflict(id, winner) {
    if (winner !== "merge") return this.repository.resolveConflict(id, { winner });
    const conflict = (await this.repository.listConflicts()).find((item) => item.id === id);
    if (!conflict) throw new Error("충돌 기록을 찾을 수 없습니다.");
    const remote = conflict.remote;
    await this.repository.resolveConflict(id, { winner: "local" });
    if (remote?.docType === "node") {
      await this.repository.createNode({
        parentId: remote.parentId || null,
        kind: remote.kind || "page",
        title: `${remote.title || "충돌 기록"} (PC 충돌 사본)`,
        summary: remote.summary || "",
        status: "draft",
        tags: remote.tags || [],
        properties: remote.properties || {},
      });
    } else if (remote?.docType === "block" && remote.nodeId) {
      await this.repository.createBlock(remote.nodeId, {
        type: remote.type,
        data: remote.data || {},
      });
    }
    return true;
  }

  async exportData() {
    return this.repository.exportData();
  }

  async importData(payload, strategy) {
    return this.repository.importData(payload, { strategy });
  }

  async applySyncConfig(config, { start = true } = {}) {
    await this.stopSync();
    this.syncConfig = config ? { ...config } : null;
    if (!config?.remoteUrl) {
      this.onSyncStatus(DEFAULT_SYNC_STATUS);
      return null;
    }
    const normalizedRemoteUrl = normalizeServerUrl(config.remoteUrl);
    const checkpoint = await this.readSyncCheckpoint(normalizedRemoteUrl);
    const transport = createSyncTransport(config, {
      onCheckpoint: (value) => { this.pendingCheckpoint = value; },
    });
    this.syncController = new SyncController(this.repository, transport, {
      live: true,
      retry: true,
      pollInterval: 5_000,
      batchSize: 3,
      checkpoint,
    });
    this.syncUnsubscribe = this.syncController.subscribe((status) => {
      if (status.lastSyncedAt && this.pendingCheckpoint !== undefined) {
        const pending = this.pendingCheckpoint;
        this.pendingCheckpoint = undefined;
        void this.persistSyncCheckpoint(normalizedRemoteUrl, pending).catch(() => {
          this.pendingCheckpoint = pending;
        });
      }
      this.onSyncStatus(status);
    });
    if (start) this.syncController.start();
    return this.syncController;
  }

  async readSyncCheckpoint(remoteUrl) {
    try {
      const document = await this.db.get("_local/title-placeholder-sync-checkpoint");
      return document.remoteUrl === remoteUrl ? document.checkpoint ?? null : null;
    } catch (error) {
      if (error?.status === 404 || error?.name === "not_found") return null;
      throw error;
    }
  }

  async persistSyncCheckpoint(remoteUrl, checkpoint) {
    const id = "_local/title-placeholder-sync-checkpoint";
    let existing = null;
    try {
      existing = await this.db.get(id);
    } catch (error) {
      if (error?.status !== 404 && error?.name !== "not_found") throw error;
    }
    await this.db.put({
      _id: id,
      ...(existing?._rev ? { _rev: existing._rev } : {}),
      remoteUrl,
      checkpoint,
      updatedAt: new Date().toISOString(),
    });
  }

  async syncNow() {
    if (this.syncNowPromise) return this.syncNowPromise;
    if (!this.syncConfig?.remoteUrl) throw new Error("먼저 PC 연결 정보를 저장하세요.");
    this.syncNowPromise = (async () => {
      await this.stopSync();
      await this.applySyncConfig(this.syncConfig, { start: true });
      return this.syncController;
    })();
    try {
      return await this.syncNowPromise;
    } finally {
      this.syncNowPromise = null;
    }
  }

  async stopSync() {
    const loop = this.syncController?._loopPromise;
    this.syncUnsubscribe?.();
    this.syncUnsubscribe = null;
    if (this.syncController) await this.syncController.stop();
    if (loop) await Promise.resolve(loop).catch(() => {});
    this.syncController = null;
    this.pendingCheckpoint = undefined;
  }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32_768)));
  }
  return btoa(chunks.join(""));
}

function isEditableTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function makeBlockData(type) {
  if (type === "text") return { html: "<p><br></p>" };
  if (type === "callout") return { tone: "info", title: "참고", text: "" };
  if (type === "image") return { assetId: "", alt: "", caption: "" };
  if (type === "youtube") return { url: "", title: "", caption: "" };
  if (type === "sheet") return { url: "", title: "", range: "" };
  return {};
}

export class AppController {
  constructor({ root, announcer, adapter } = {}) {
    if (!root) throw new TypeError("앱 루트 요소가 필요합니다.");
    this.root = root;
    this.announcer = announcer;
    this.platform = detectPlatform();
    this.adapter = adapter || new RepositoryAdapter({
      onSyncStatus: (status) => this.handleSyncStatus(status),
    });
    this.deferredInstallPrompt = null;
    this.autosaveTimer = null;
    this.toastTimer = null;
    this.syncRenderTimer = null;
    this.editorDirty = false;
    this.editorSaving = false;
    this.draggedNodeId = "";
    this.draggedBlockId = "";
    this.dropTargetId = "";
    this.dropPosition = "";
    this.savedSelection = null;
    this.objectUrls = new Set();
    this.started = false;
    this.bound = {};
    const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone;
    this.state = {
      route: parseRoute(),
      platform: this.platform,
      online: navigator.onLine !== false,
      installAvailable: !this.platform.isNative && !standalone,
      installDismissed: localStorage.getItem(INSTALL_DISMISSED_KEY) === "1",
      drawerOpen: false,
      inspectorOpen: false,
      nodes: [],
      deletedNodes: [],
      activeNode: null,
      activeBlocks: [],
      editorBlocks: [],
      searchQuery: "",
      searchResults: [],
      revisions: [],
      conflicts: [],
      runtimeInfo: null,
      syncStatus: { ...DEFAULT_SYNC_STATUS },
      syncTone: "warning",
      syncLabel: "연결 대기",
      unsyncedCount: 0,
      activeCount: 0,
      trashCount: 0,
      assetCount: 0,
      storageEstimate: { used: "계산 중", label: "LOCAL", percent: 0 },
      editorSaveState: "idle",
      editorSaveLabel: "이 기기에 저장됨",
      structureSaveState: "idle",
      structureSaveLabel: "이 기기에 저장됨",
      toast: null,
      settings: readSettings(this.platform),
      getAncestors: (id) => this.getAncestors(id),
    };
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    this.bindGlobalEvents();
    const identity = await this.adapter.init();
    if (identity?.deviceId) {
      this.state.settings.archiveId = this.state.settings.archiveId || identity.deviceId.slice(0, 12).toUpperCase();
      if (!this.state.settings.deviceName && identity.name) this.state.settings.deviceName = identity.name;
    }

    await this.loadRuntimeInfo();
    const config = this.syncConfigForPlatform();
    if (config.remoteUrl && this.state.settings.autoSync) {
      try {
        await this.adapter.applySyncConfig(config, { start: this.state.online });
      } catch (error) {
        this.state.syncStatus = { ...DEFAULT_SYNC_STATUS, state: "error", error: { message: error.message } };
      }
    }

    await Promise.all([this.reloadNodes(), this.refreshPendingCount(), this.refreshStorageEstimate()]);
    await this.loadRoute({ focusMain: false });
    this.root.removeAttribute("aria-busy");
    return this;
  }

  bindGlobalEvents() {
    this.bound.click = (event) => void this.handleClick(event);
    this.bound.submit = (event) => void this.handleSubmit(event);
    this.bound.input = (event) => this.handleInput(event);
    this.bound.change = (event) => void this.handleChange(event);
    this.bound.pointerdown = (event) => this.handlePointerDown(event);
    this.bound.keydown = (event) => this.handleKeyDown(event);
    this.bound.hashchange = () => void this.loadRoute({ focusMain: true });
    this.bound.online = () => this.handleNetworkChange(true);
    this.bound.offline = () => this.handleNetworkChange(false);
    this.bound.beforeinstallprompt = (event) => {
      event.preventDefault();
      this.deferredInstallPrompt = event;
      this.state.installAvailable = !this.platform.isNative;
      this.render();
    };
    this.bound.appinstalled = () => {
      this.deferredInstallPrompt = null;
      this.state.installAvailable = false;
      this.showToast("이 기기에 Local Archive를 설치했습니다.", "success");
    };
    this.bound.dragstart = (event) => this.handleDragStart(event);
    this.bound.dragover = (event) => this.handleDragOver(event);
    this.bound.drop = (event) => void this.handleDrop(event);
    this.bound.dragend = () => this.clearDragState();
    this.bound.selectionchange = () => this.rememberSelection();

    this.root.addEventListener("click", this.bound.click);
    this.root.addEventListener("submit", this.bound.submit);
    this.root.addEventListener("input", this.bound.input);
    this.root.addEventListener("change", this.bound.change);
    this.root.addEventListener("pointerdown", this.bound.pointerdown);
    this.root.addEventListener("dragstart", this.bound.dragstart);
    this.root.addEventListener("dragover", this.bound.dragover);
    this.root.addEventListener("drop", this.bound.drop);
    this.root.addEventListener("dragend", this.bound.dragend);
    document.addEventListener("keydown", this.bound.keydown);
    document.addEventListener("selectionchange", this.bound.selectionchange);
    window.addEventListener("hashchange", this.bound.hashchange);
    window.addEventListener("online", this.bound.online);
    window.addEventListener("offline", this.bound.offline);
    window.addEventListener("beforeinstallprompt", this.bound.beforeinstallprompt);
    window.addEventListener("appinstalled", this.bound.appinstalled);
  }

  async loadRuntimeInfo() {
    if (!window.desktopBridge?.getRuntimeInfo) return;
    try {
      const [runtime, autoStart] = await Promise.all([
        window.desktopBridge.getRuntimeInfo(),
        window.desktopBridge.getAutoStart?.() ?? Promise.resolve(false),
      ]);
      this.state.runtimeInfo = { ...runtime, autoStart: Boolean(autoStart) };
      if (runtime?.localUrl) {
        this.state.settings = {
          ...this.state.settings,
          remoteUrl: runtime.localUrl,
          username: runtime.username || this.state.settings.username,
          password: runtime.password || this.state.settings.password,
          deviceName: this.state.settings.deviceName || "집 PC",
        };
      }
    } catch (error) {
      console.warn("PC 실행 정보를 읽지 못했습니다.", error);
    }
  }

  syncConfigForPlatform() {
    const settings = this.state.settings;
    return {
      remoteUrl: settings.remoteUrl,
      username: settings.username,
      password: settings.password,
    };
  }

  async applySyncConfig(config, { persist = true, start = true } = {}) {
    const next = {
      ...this.state.settings,
      remoteUrl: normalizeServerUrl(config.remoteUrl || ""),
      username: String(config.username || "wiki-sync").trim(),
      password: String(config.password || ""),
      ...(config.deviceName ? { deviceName: String(config.deviceName).trim() } : {}),
      ...(typeof config.autoSync === "boolean" ? { autoSync: config.autoSync } : {}),
    };
    if (next.remoteUrl && (!next.username || !next.password)) throw new Error("PC 사용자명과 비밀번호를 모두 입력하세요.");
    this.state.settings = next;
    if (persist) persistSettings(next);
    await this.adapter.applySyncConfig(this.syncConfigForPlatform(), { start: start && this.state.online });
    return next;
  }

  async reloadNodes() {
    const nodes = await this.adapter.listNodes(true);
    this.state.nodes = sortByOrder(nodes.filter((node) => !node.deletedAt));
    this.state.deletedNodes = nodes.filter((node) => node.deletedAt).sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));
    this.state.activeCount = this.state.nodes.length;
    this.state.trashCount = this.state.deletedNodes.length;
  }

  async refreshPendingCount() {
    try {
      this.state.unsyncedCount = await this.adapter.getPendingCount();
    } catch {
      this.state.unsyncedCount = 0;
    }
    this.deriveSyncPresentation();
  }

  async refreshStorageEstimate() {
    try {
      const [estimate, assets] = await Promise.all([
        navigator.storage?.estimate?.() || Promise.resolve({ usage: 0, quota: 0 }),
        this.adapter.listAssets(),
      ]);
      const usage = Number(estimate.usage) || 0;
      const quota = Number(estimate.quota) || 0;
      this.state.assetCount = assets.length;
      this.state.storageEstimate = {
        used: formatBytes(usage),
        label: quota ? `${formatBytes(usage)} / ${formatBytes(quota)}` : "LOCAL STORAGE",
        percent: quota ? Math.max(1, Math.min(100, Math.round((usage / quota) * 100))) : 1,
      };
    } catch {
      this.state.storageEstimate = { used: "기기 저장소", label: "LOCAL STORAGE", percent: 1 };
    }
  }

  deriveSyncPresentation() {
    const status = this.state.syncStatus;
    if (!this.state.online) {
      this.state.syncTone = "warning";
      this.state.syncLabel = "오프라인 보관 중";
    } else if (status.state === "error") {
      this.state.syncTone = "error";
      this.state.syncLabel = "연결 확인 필요";
    } else if (status.state === "active" || status.state === "connecting") {
      this.state.syncTone = "active";
      this.state.syncLabel = status.state === "connecting" ? "PC 연결 중" : "동기화 중";
    } else if (this.state.unsyncedCount) {
      this.state.syncTone = "warning";
      this.state.syncLabel = "PC 동기화 대기";
    } else if (status.lastSyncedAt) {
      this.state.syncTone = "success";
      this.state.syncLabel = "동기화 완료";
    } else {
      this.state.syncTone = "warning";
      this.state.syncLabel = this.state.settings.remoteUrl ? "연결 대기" : "PC 연결 필요";
    }
  }

  handleSyncStatus(status) {
    const previousSync = this.state.syncStatus.lastSyncedAt;
    this.state.syncStatus = { ...DEFAULT_SYNC_STATUS, ...status };
    this.deriveSyncPresentation();
    if (status.lastSyncedAt && status.lastSyncedAt !== previousSync) {
      void this.refreshAfterSync();
      return;
    }
    if (this.state.route.name !== "edit") this.scheduleSyncRender();
  }

  async refreshAfterSync() {
    await Promise.all([this.reloadNodes(), this.refreshPendingCount()]);
    if (this.state.route.name !== "edit") await this.loadRoute({ focusMain: false, skipFlush: true });
  }

  scheduleSyncRender() {
    clearTimeout(this.syncRenderTimer);
    this.syncRenderTimer = setTimeout(() => this.render(), 120);
  }

  handleNetworkChange(online) {
    this.state.online = online;
    this.deriveSyncPresentation();
    if (online && this.state.settings.autoSync && this.state.settings.remoteUrl && !this.adapter.syncController) {
      void this.adapter.applySyncConfig(this.syncConfigForPlatform(), { start: true }).catch((error) => this.showToast(error.message, "error"));
    }
    this.render();
  }

  getAncestors(nodeId) {
    const byId = new Map(this.state.nodes.map((node) => [node.id, node]));
    const result = [];
    const visited = new Set([nodeId]);
    let node = byId.get(nodeId);
    while (node?.parentId && !visited.has(node.parentId)) {
      visited.add(node.parentId);
      const parent = byId.get(node.parentId);
      if (!parent) break;
      result.unshift(parent);
      node = parent;
    }
    return result;
  }

  async loadRoute({ focusMain = false, skipFlush = false } = {}) {
    if (!skipFlush && this.state.route.name === "edit" && this.editorDirty) {
      await this.saveEditor({ createRevision: false, quiet: true }).catch(() => {});
    }
    this.revokeObjectUrls();
    this.state.route = parseRoute();
    this.state.drawerOpen = false;
    this.state.inspectorOpen = false;
    this.state.activeNode = null;
    this.state.activeBlocks = [];
    this.state.editorBlocks = [];
    this.state.revisions = [];
    const id = this.state.route.params.id;

    if (["folder", "page", "edit", "revisions"].includes(this.state.route.name)) {
      let node = this.state.nodes.find((item) => item.id === id);
      if (!node) {
        await this.reloadNodes();
        node = this.state.nodes.find((item) => item.id === id);
      }
      if (!node || (this.state.route.name === "folder" && node.kind !== "folder") || (["page", "edit", "revisions"].includes(this.state.route.name) && node.kind !== "page")) {
        this.state.route = { name: "not-found", params: {}, query: new URLSearchParams() };
      } else {
        this.state.activeNode = node;
        if (["page", "edit"].includes(this.state.route.name)) {
          const blocks = await this.adapter.listBlocks(node.id);
          this.state.activeBlocks = blocks;
          this.state.editorBlocks = blocks.map(normalizeBlock);
        }
        if (this.state.route.name === "revisions") this.state.revisions = await this.adapter.listRevisions(node.id);
      }
    }

    if (this.state.route.name === "search") {
      const query = this.state.route.query.get("q")?.trim() || "";
      this.state.searchQuery = query;
      this.state.searchResults = query
        ? await this.adapter.search(query)
        : [...this.state.nodes].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).slice(0, 12);
    } else if (!this.state.searchQuery) {
      this.state.searchResults = [];
    }

    if (this.state.route.name === "settings") {
      await Promise.all([
        this.adapter.listConflicts().then((conflicts) => { this.state.conflicts = conflicts; }),
        this.refreshStorageEstimate(),
      ]);
      await this.loadRuntimeInfo();
    }

    this.render({ focusMain });
  }

  captureEditorDraft() {
    const editor = this.root.querySelector("[data-editor-root]");
    if (!editor || !this.state.activeNode) return;
    const title = editor.querySelector("#editor-title")?.value ?? this.state.activeNode.title;
    const summary = editor.querySelector("#editor-summary")?.value ?? this.state.activeNode.summary;
    const parentId = editor.querySelector("#editor-parent")?.value || null;
    const status = editor.querySelector("#editor-status")?.value || this.state.activeNode.status;
    const tags = (editor.querySelector("#editor-tags")?.value || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    this.state.activeNode = { ...this.state.activeNode, title, summary, parentId, status, tags };

    const currentById = new Map(this.state.editorBlocks.map((block) => [block.id, block]));
    this.state.editorBlocks = Array.from(editor.querySelectorAll("[data-editor-block]")).map((element) => {
      const id = element.dataset.blockId;
      const type = element.dataset.blockType || "text";
      const existing = currentById.get(id) || { id, data: {} };
      return { ...existing, blockType: type, type: canonicalBlockType(type), data: this.readBlockData(element, existing.data) };
    });
    this.state.activeBlocks = this.state.editorBlocks;
  }

  readBlockData(element, fallback = {}) {
    const type = element.dataset.blockType || "text";
    if (type === "text") {
      const html = element.querySelector("[data-block-field='html']")?.innerHTML || "<p><br></p>";
      return { ...fallback, html: sanitizeUserHtml(html) };
    }
    if (type === "divider") return {};
    const data = { ...fallback };
    element.querySelectorAll("[data-block-field]").forEach((field) => {
      data[field.dataset.blockField] = field.value;
    });
    return data;
  }

  render({ focusMain = false } = {}) {
    if (this.root.querySelector("[data-editor-root]")) this.captureEditorDraft();
    this.deriveSyncPresentation();
    this.root.className = this.state.route.name === "edit" ? "app-root app-root--editor" : "app-root";
    this.root.innerHTML = renderApp(this.state);
    document.body.classList.toggle("drawer-open", this.state.drawerOpen);
    document.body.classList.remove("search-open");
    this.root.removeAttribute("aria-busy");
    if (focusMain) requestAnimationFrame(() => this.root.querySelector("#main-content")?.focus({ preventScroll: true }));
    requestAnimationFrame(() => void this.hydrateAssets());
  }

  async hydrateAssets() {
    const targets = Array.from(this.root.querySelectorAll("[data-asset-id]")).filter((element) => element.dataset.assetId);
    const grouped = new Map();
    targets.forEach((element) => {
      const list = grouped.get(element.dataset.assetId) || [];
      list.push(element);
      grouped.set(element.dataset.assetId, list);
    });
    await Promise.all(Array.from(grouped, async ([assetId, elements]) => {
      try {
        const asset = await this.adapter.getAsset(assetId);
        const attachment = asset?.attachment;
        if (!attachment?.data) return;
        const blob = attachment.data instanceof Blob
          ? attachment.data
          : new Blob([attachment.data], { type: attachment.contentType || asset.mimeType || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        this.objectUrls.add(url);
        elements.forEach((element) => {
          const frame = element.matches(".image-block") ? element.querySelector(".image-block__frame") : element.querySelector(".image-editor__preview");
          if (!frame) return;
          const image = document.createElement("img");
          image.src = url;
          const block = [...this.state.activeBlocks, ...this.state.editorBlocks].find((item) => item.data?.assetId === assetId);
          image.alt = block?.data?.alt || asset.altText || "";
          frame.replaceChildren(image);
        });
      } catch (error) {
        console.warn(`이미지 ${assetId}을 불러오지 못했습니다.`, error);
      }
    }));
  }

  revokeObjectUrls() {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
  }

  announce(message) {
    if (!this.announcer) return;
    this.announcer.textContent = "";
    requestAnimationFrame(() => { this.announcer.textContent = message; });
  }

  showToast(message, tone = "info") {
    clearTimeout(this.toastTimer);
    this.state.toast = { message, tone };
    this.render();
    this.announce(message);
    this.toastTimer = setTimeout(() => {
      this.state.toast = null;
      this.render();
    }, 4_200);
  }

  closeDialog(id) {
    const dialog = this.root.querySelector(`#${CSS.escape(id)}`);
    if (dialog?.open && typeof dialog.close === "function") dialog.close();
    else dialog?.removeAttribute("open");
  }

  openCreateDialog({ kind = "page", parentId = "", title = "", editId = "" } = {}) {
    const dialog = this.root.querySelector("#create-dialog");
    const form = dialog?.querySelector("[data-create-form]");
    if (!dialog || !form) return;
    form.reset();
    form.dataset.editId = editId;
    const node = editId ? this.state.nodes.find((item) => item.id === editId) : null;
    const selectedKind = node?.kind || kind;
    const radio = form.querySelector(`[name='kind'][value='${selectedKind === "folder" ? "folder" : "page"}']`);
    if (radio) radio.checked = true;
    form.elements.title.value = node?.title || title;
    form.elements.summary.value = node?.summary || "";
    form.elements.parentId.value = node?.parentId || parentId || "";
    form.elements.published.checked = node?.status === "published";
    form.querySelectorAll("[name='kind']").forEach((input) => { input.disabled = Boolean(node); });
    const heading = form.querySelector("#create-dialog-title");
    if (heading) heading.textContent = node ? "기록 정보 편집" : "새 기록 만들기";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => form.elements.title.focus());
  }

  async handleClick(event) {
    const commandButton = event.target.closest("[data-command]");
    if (commandButton) {
      event.preventDefault();
      this.applyTextCommand(commandButton.dataset.command);
      return;
    }

    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.action;

    if (action === "open-drawer") {
      this.state.drawerOpen = true;
      this.render();
      return;
    }
    if (action === "close-drawer") {
      this.state.drawerOpen = false;
      this.render();
      return;
    }
    if (action === "focus-search") {
      document.body.classList.add("search-open");
      requestAnimationFrame(() => this.root.querySelector("#global-query")?.focus());
      return;
    }
    if (action === "open-create") {
      this.openCreateDialog({
        kind: actionElement.dataset.kind || "page",
        parentId: actionElement.dataset.parentId || (this.state.route.name === "folder" ? this.state.activeNode?.id : "") || "",
        title: actionElement.dataset.title || "",
      });
      return;
    }
    if (action === "edit-node-meta") {
      this.openCreateDialog({ editId: actionElement.dataset.nodeId });
      return;
    }
    if (action === "close-dialog") {
      this.closeDialog(actionElement.dataset.dialog);
      return;
    }
    if (action === "dismiss-install") {
      this.state.installDismissed = true;
      localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
      this.render();
      return;
    }
    if (action === "install-app") {
      await this.installApp();
      return;
    }
    if (action === "sync-now") {
      await this.syncNow();
      return;
    }
    if (action === "toggle-sync") {
      await this.toggleSync();
      return;
    }
    if (action === "toggle-inspector") {
      this.captureEditorDraft();
      this.state.inspectorOpen = !this.state.inspectorOpen;
      this.render();
      return;
    }
    if (action === "add-block") {
      await this.addBlock(actionElement.dataset.blockType);
      return;
    }
    if (action === "remove-block") {
      await this.removeBlock(actionElement.dataset.blockId);
      return;
    }
    if (action === "move-block") {
      await this.moveBlock(actionElement.dataset.blockId, actionElement.dataset.direction);
      return;
    }
    if (action === "save-draft") {
      const status = this.root.querySelector("#editor-status");
      if (status) status.value = "draft";
      await this.saveEditor({ createRevision: true, reason: this.root.querySelector("#editor-reason")?.value || "초안 저장" });
      return;
    }
    if (action === "publish-page") {
      const status = this.root.querySelector("#editor-status");
      if (status) status.value = "published";
      await this.saveEditor({ createRevision: true, reason: this.root.querySelector("#editor-reason")?.value || "게시" });
      return;
    }
    if (action === "trash-node") {
      await this.trashNode(actionElement.dataset.nodeId);
      return;
    }
    if (action === "restore-node") {
      await this.restoreNode(actionElement.dataset.nodeId);
      return;
    }
    if (action === "move-node") {
      await this.moveNode(actionElement.dataset.nodeId, actionElement.dataset.direction);
      return;
    }
    if (action === "toggle-branch") {
      const item = actionElement.closest(".structure-item");
      item?.classList.toggle("is-collapsed");
      actionElement.setAttribute("aria-expanded", item?.classList.contains("is-collapsed") ? "false" : "true");
      return;
    }
    if (action === "open-import") {
      this.root.querySelector("#import-file")?.click();
      return;
    }
    if (action === "export-data") {
      await this.exportData();
      return;
    }
    if (action === "resolve-conflict") {
      await this.resolveConflict(actionElement.dataset.conflictId, actionElement.dataset.winner);
      return;
    }
    if (action === "preview-revision") {
      this.previewRevision(actionElement.dataset.revisionId);
      return;
    }
    if (action === "restore-revision") {
      await this.restoreRevision(actionElement.dataset.revisionId);
      return;
    }
    if (action === "open-external") {
      await this.openExternal(actionElement.dataset.url);
      return;
    }
    if (action === "toggle-secret") {
      this.toggleSecret(actionElement.dataset.secretTarget, actionElement);
      return;
    }
    if (action === "copy-field") {
      await this.copyField(actionElement.dataset.copyTarget);
      return;
    }
    if (action === "configure-tailscale") {
      await this.configureTailscale();
      return;
    }
    if (action === "create-desktop-backup") {
      await this.createDesktopBackup();
      return;
    }
    if (action === "open-backup-folder") {
      await this.openBackupFolder();
      return;
    }
    if (action === "dismiss-toast") {
      clearTimeout(this.toastTimer);
      this.state.toast = null;
      this.render();
    }
  }

  async handleSubmit(event) {
    const searchForm = event.target.closest("[data-search-form]");
    if (searchForm) {
      event.preventDefault();
      const query = new FormData(searchForm).get("q")?.toString().trim() || "";
      this.state.searchQuery = query;
      location.hash = `#/search${query ? `?q=${encodeURIComponent(query)}` : ""}`;
      return;
    }

    const createForm = event.target.closest("[data-create-form]");
    if (createForm) {
      event.preventDefault();
      await this.submitCreateForm(createForm);
      return;
    }

    const pairingForm = event.target.closest("[data-pairing-form]");
    if (pairingForm) {
      event.preventDefault();
      const form = new FormData(pairingForm);
      try {
        await this.applySyncConfig({
          remoteUrl: form.get("remoteUrl")?.toString() || "",
          username: form.get("username")?.toString() || "",
          password: form.get("password")?.toString() || "",
          deviceName: form.get("deviceName")?.toString() || "",
          autoSync: form.get("autoSync") === "on",
        });
        await this.refreshPendingCount();
        this.showToast("PC 연결 설정을 저장했습니다.", "success");
      } catch (error) {
        this.showToast(error.message, "error");
      }
    }
  }

  handleInput(event) {
    if (!event.target.closest("[data-editor-root]")) return;
    if (event.target.matches("[type='file']")) return;
    this.editorDirty = true;
    this.setEditorStatus("변경 저장 대기", "saving");
    this.scheduleAutosave();
  }

  async handleChange(event) {
    const desktopAutoStart = event.target.closest("[data-desktop-autostart]");
    if (desktopAutoStart) {
      await this.setDesktopAutoStart(desktopAutoStart.checked);
      return;
    }
    const format = event.target.closest("[data-format]");
    if (format) {
      this.applyTextCommand(format.dataset.format, format.value);
      return;
    }
    const imageInput = event.target.closest("[data-image-upload]");
    if (imageInput?.files?.[0]) {
      await this.uploadImage(imageInput.dataset.blockId, imageInput.files[0]);
      return;
    }
    const importInput = event.target.closest("[data-import-file]");
    if (importInput?.files?.[0]) {
      await this.importData(importInput.files[0]);
      importInput.value = "";
      return;
    }
    if (event.target.closest("[data-editor-root]")) {
      this.editorDirty = true;
      this.setEditorStatus("변경 저장 대기", "saving");
      this.scheduleAutosave();
    }
  }

  handlePointerDown(event) {
    if (event.target.closest("[data-command]")) event.preventDefault();
    const nodeHandle = event.target.closest("[data-drag-handle]");
    const blockHandle = event.target.closest("[data-block-drag]");
    if (nodeHandle) this.dragIntent = { type: "node", id: nodeHandle.closest(".structure-item")?.dataset.nodeId || "" };
    else if (blockHandle) this.dragIntent = { type: "block", id: blockHandle.closest("[data-editor-block]")?.dataset.blockId || "" };
    else this.dragIntent = null;
  }

  handleKeyDown(event) {
    if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event.target) && this.state.route.name !== "edit") {
      event.preventDefault();
      document.body.classList.add("search-open");
      this.root.querySelector("#global-query")?.focus();
      return;
    }
    if (event.key === "Escape") {
      document.body.classList.remove("search-open");
      if (this.state.drawerOpen) {
        this.state.drawerOpen = false;
        this.render();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && this.state.route.name === "edit") {
      event.preventDefault();
      void this.saveEditor({ createRevision: true, reason: this.root.querySelector("#editor-reason")?.value || "수동 저장" });
    }
  }

  rememberSelection() {
    const selection = document.getSelection?.();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const editable = (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest?.(".editable-rich");
    if (editable) this.savedSelection = { range: range.cloneRange(), editable };
  }

  applyTextCommand(command, value = null) {
    const selected = this.savedSelection;
    if (selected?.editable?.isConnected) {
      const selection = document.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(selected.range);
      selected.editable.focus();
    }
    if (typeof document.execCommand === "function") document.execCommand(command, false, value);
    this.editorDirty = true;
    this.setEditorStatus("변경 저장 대기", "saving");
    this.scheduleAutosave();
    this.rememberSelection();
  }

  async submitCreateForm(form) {
    const values = new FormData(form);
    const editId = form.dataset.editId || "";
    const kind = values.get("kind") === "folder" ? "folder" : "page";
    const title = values.get("title")?.toString().trim() || "";
    if (!title) {
      form.elements.title.focus();
      this.announce("제목을 입력하세요.");
      return;
    }
    const input = {
      title,
      summary: values.get("summary")?.toString().trim() || "",
      parentId: values.get("parentId")?.toString() || null,
      status: values.get("published") === "on" ? "published" : "draft",
      kind,
    };
    try {
      let node;
      if (editId) {
        node = await this.adapter.updateNode(editId, input);
      } else {
        node = await this.adapter.createNode(input);
        if (kind === "page") await this.adapter.createBlock(node.id, { type: "rich_text", data: makeBlockData("text") });
      }
      this.closeDialog("create-dialog");
      await Promise.all([this.reloadNodes(), this.refreshPendingCount()]);
      this.showToast(editId ? "기록 정보를 수정했습니다." : "새 기록을 만들었습니다.", "success");
      const destination = kind === "folder" ? `#/folder/${node.id}` : `#/edit/${node.id}`;
      if (location.hash !== destination) location.hash = destination;
      else await this.loadRoute({ focusMain: true, skipFlush: true });
    } catch (error) {
      this.showToast(error.message || "기록을 만들지 못했습니다.", "error");
    }
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => void this.saveEditor({ createRevision: false, quiet: true }), AUTOSAVE_DELAY);
  }

  setEditorStatus(label, state) {
    this.state.editorSaveLabel = label;
    this.state.editorSaveState = state;
    const element = this.root.querySelector(".editor-topbar .save-status");
    if (element) {
      element.className = `save-status save-status--${state}`;
      const textNode = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.textContent = label;
      else element.append(document.createTextNode(label));
    }
  }

  collectEditorPayload() {
    const editor = this.root.querySelector("[data-editor-root]");
    if (!editor || !this.state.activeNode) return null;
    const title = editor.querySelector("#editor-title")?.value.trim() || "";
    if (!title) throw new Error("문서 제목을 입력하세요.");
    const blocksById = new Map(this.state.editorBlocks.map((block) => [block.id, block]));
    return {
      node: {
        title,
        summary: editor.querySelector("#editor-summary")?.value.trim() || "",
        parentId: editor.querySelector("#editor-parent")?.value || null,
        tags: (editor.querySelector("#editor-tags")?.value || "").split(",").map((tag) => tag.trim()).filter(Boolean),
        status: editor.querySelector("#editor-status")?.value === "published" ? "published" : "draft",
      },
      blocks: Array.from(editor.querySelectorAll("[data-editor-block]")).map((element) => {
        const id = element.dataset.blockId;
        const block = blocksById.get(id) || { id, data: {} };
        return {
          ...block,
          id,
          type: canonicalBlockType(element.dataset.blockType),
          blockType: element.dataset.blockType,
          data: this.readBlockData(element, block.data),
        };
      }),
    };
  }

  async saveEditor({ createRevision = false, reason = "", quiet = false } = {}) {
    if (this.editorSaving || this.state.route.name !== "edit" || !this.state.activeNode) return;
    clearTimeout(this.autosaveTimer);
    let payload;
    try {
      payload = this.collectEditorPayload();
    } catch (error) {
      this.setEditorStatus(error.message, "error");
      if (!quiet) this.showToast(error.message, "error");
      throw error;
    }
    if (!payload) return;
    this.editorSaving = true;
    this.setEditorStatus("이 기기에 저장 중…", "saving");
    try {
      const updatedNode = await this.adapter.updateNode(this.state.activeNode.id, payload.node);
      const updatedBlocks = [];
      for (const block of payload.blocks) {
        updatedBlocks.push(await this.adapter.updateBlock(block.id, { type: block.type, data: block.data }));
      }
      if (createRevision) await this.adapter.saveRevision(updatedNode.id, reason || "수동 저장");
      this.state.activeNode = updatedNode;
      this.state.editorBlocks = updatedBlocks;
      this.state.activeBlocks = updatedBlocks;
      this.state.nodes = this.state.nodes.map((node) => node.id === updatedNode.id ? updatedNode : node);
      this.editorDirty = false;
      await this.refreshPendingCount();
      this.setEditorStatus(this.state.online ? "이 기기에 저장됨" : "오프라인 · 동기화 대기", "saved");
      this.announce("변경 내용을 이 기기에 저장했습니다.");
      if (createRevision && !quiet) {
        this.showToast(updatedNode.status === "published" ? "문서를 게시하고 변경 이력을 남겼습니다." : "초안과 변경 이력을 저장했습니다.", "success");
      }
    } catch (error) {
      this.editorDirty = true;
      this.setEditorStatus("저장 실패 · 다시 시도", "error");
      if (!quiet) this.showToast(error.message || "변경 내용을 저장하지 못했습니다.", "error");
      throw error;
    } finally {
      this.editorSaving = false;
    }
  }

  async addBlock(type) {
    if (!this.state.activeNode) return;
    try {
      if (this.editorDirty) await this.saveEditor({ quiet: true });
      const block = await this.adapter.createBlock(this.state.activeNode.id, {
        type: canonicalBlockType(type),
        data: makeBlockData(type),
      });
      this.state.editorBlocks.push(normalizeBlock(block));
      this.state.activeBlocks = this.state.editorBlocks;
      await this.refreshPendingCount();
      this.render();
      requestAnimationFrame(() => {
        const created = this.root.querySelector(`[data-block-id='${CSS.escape(block.id)}']`);
        created?.scrollIntoView({ behavior: "smooth", block: "center" });
        created?.querySelector("[contenteditable='true'], input, textarea")?.focus();
      });
    } catch (error) {
      this.showToast(error.message || "블록을 추가하지 못했습니다.", "error");
    }
  }

  async removeBlock(id) {
    if (!id) return;
    try {
      if (this.editorDirty) await this.saveEditor({ quiet: true });
      await this.adapter.deleteBlock(id);
      this.state.editorBlocks = this.state.editorBlocks.filter((block) => block.id !== id);
      this.state.activeBlocks = this.state.editorBlocks;
      await this.refreshPendingCount();
      this.render();
      this.announce("블록을 삭제했습니다.");
    } catch (error) {
      this.showToast(error.message || "블록을 삭제하지 못했습니다.", "error");
    }
  }

  async moveBlock(id, direction) {
    if (this.editorDirty) await this.saveEditor({ quiet: true }).catch(() => {});
    const blocks = sortByOrder(this.state.editorBlocks);
    const index = blocks.findIndex((block) => block.id === id);
    if (index < 0) return;
    let patch = null;
    if (direction === "up" && index > 0) patch = { beforeId: blocks[index - 1].id };
    if (direction === "down" && index < blocks.length - 1) patch = { afterId: blocks[index + 1].id };
    if (!patch) return;
    try {
      await this.adapter.moveBlock(id, patch);
      this.state.editorBlocks = await this.adapter.listBlocks(this.state.activeNode.id);
      this.state.activeBlocks = this.state.editorBlocks;
      await this.refreshPendingCount();
      this.render();
    } catch (error) {
      this.showToast(error.message || "블록 순서를 바꾸지 못했습니다.", "error");
    }
  }

  async uploadImage(blockId, file) {
    if (!file?.type?.startsWith("image/")) {
      this.showToast("이미지 파일을 선택하세요.", "error");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      this.showToast("이미지는 10MB 이하만 저장할 수 있습니다.", "error");
      return;
    }
    if (this.editorDirty) await this.saveEditor({ quiet: true }).catch(() => {});
    this.captureEditorDraft();
    const block = this.state.editorBlocks.find((item) => item.id === blockId);
    if (!block) return;
    this.setEditorStatus("이미지 저장 중…", "saving");
    try {
      const asset = await this.adapter.addAsset(this.state.activeNode.id, file, block.data);
      const updated = await this.adapter.updateBlock(blockId, {
        type: "image",
        data: { ...block.data, assetId: asset.id },
      });
      this.state.editorBlocks = this.state.editorBlocks.map((item) => item.id === blockId ? updated : item);
      this.state.activeBlocks = this.state.editorBlocks;
      await Promise.all([this.refreshPendingCount(), this.refreshStorageEstimate()]);
      this.setEditorStatus("이미지를 이 기기에 저장함", "saved");
      this.render();
    } catch (error) {
      this.setEditorStatus("이미지 저장 실패", "error");
      this.showToast(error.message || "이미지를 저장하지 못했습니다.", "error");
    }
  }

  async trashNode(id) {
    if (!id) return;
    try {
      await this.adapter.deleteNode(id);
      await Promise.all([this.reloadNodes(), this.refreshPendingCount()]);
      this.showToast("기록을 휴지통으로 이동했습니다. 언제든 복원할 수 있습니다.", "success");
      location.hash = "#/trash";
    } catch (error) {
      this.showToast(error.message || "기록을 휴지통으로 옮기지 못했습니다.", "error");
    }
  }

  async restoreNode(id) {
    try {
      await this.adapter.restoreNode(id);
      await Promise.all([this.reloadNodes(), this.refreshPendingCount()]);
      this.showToast("기록을 원래 위치로 복원했습니다.", "success");
    } catch (error) {
      this.showToast(error.message || "기록을 복원하지 못했습니다.", "error");
    }
  }

  async moveNode(id, direction) {
    const node = this.state.nodes.find((item) => item.id === id);
    if (!node) return;
    const siblings = sortByOrder(this.state.nodes.filter((item) => (item.parentId || null) === (node.parentId || null)));
    const index = siblings.findIndex((item) => item.id === id);
    let patch = null;
    if (direction === "up" && index > 0) patch = { parentId: node.parentId || null, beforeId: siblings[index - 1].id };
    if (direction === "down" && index < siblings.length - 1) patch = { parentId: node.parentId || null, afterId: siblings[index + 1].id };
    if (direction === "indent" && index > 0 && siblings[index - 1].kind === "folder") {
      const parent = siblings[index - 1];
      const children = sortByOrder(this.state.nodes.filter((item) => item.parentId === parent.id && item.id !== id));
      patch = { parentId: parent.id, ...(children.length ? { afterId: children.at(-1).id } : {}) };
    }
    if (direction === "outdent" && node.parentId) {
      const parent = this.state.nodes.find((item) => item.id === node.parentId);
      if (parent) patch = { parentId: parent.parentId || null, afterId: parent.id };
    }
    if (!patch) return;
    await this.commitNodeMove(id, patch);
  }

  async commitNodeMove(id, patch) {
    this.state.structureSaveState = "saving";
    this.state.structureSaveLabel = "구조 저장 중…";
    this.render();
    try {
      await this.adapter.moveNode(id, patch);
      await Promise.all([this.reloadNodes(), this.refreshPendingCount()]);
      this.state.structureSaveState = "saved";
      this.state.structureSaveLabel = "이 기기에 저장됨";
      this.render();
      this.announce("기록 순서를 변경했습니다.");
    } catch (error) {
      this.state.structureSaveState = "error";
      this.state.structureSaveLabel = "이동 실패";
      this.showToast(error.message || "기록 구조를 변경하지 못했습니다.", "error");
    }
  }

  handleDragStart(event) {
    const node = event.target.closest?.(".structure-item");
    if (node) {
      if (this.dragIntent?.type !== "node" || this.dragIntent.id !== node.dataset.nodeId) {
        event.preventDefault();
        return;
      }
      this.draggedNodeId = node.dataset.nodeId;
      node.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", this.draggedNodeId);
      return;
    }
    const block = event.target.closest?.("[data-editor-block]");
    if (block) {
      if (this.dragIntent?.type !== "block" || this.dragIntent.id !== block.dataset.blockId) {
        event.preventDefault();
        return;
      }
      this.draggedBlockId = block.dataset.blockId;
      block.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", this.draggedBlockId);
    }
  }

  handleDragOver(event) {
    if (this.draggedNodeId) {
      const tree = event.target.closest?.("[data-structure-tree]");
      if (!tree) return;
      const target = event.target.closest(".structure-item");
      const dragged = tree.querySelector(`[data-node-id='${CSS.escape(this.draggedNodeId)}']`);
      if (target && (target === dragged || dragged?.contains(target))) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      this.clearDropIndicators();
      if (!target) {
        this.dropPosition = "root-end";
        tree.classList.add("is-drop-at-end");
        return;
      }
      const row = target.querySelector(":scope > .structure-row");
      const rectangle = row.getBoundingClientRect();
      const ratio = (event.clientY - rectangle.top) / Math.max(1, rectangle.height);
      const folder = target.dataset.kind === "folder";
      this.dropPosition = ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : folder ? "inside" : ratio < 0.5 ? "before" : "after";
      this.dropTargetId = target.dataset.nodeId;
      target.classList.add(`is-drop-${this.dropPosition}`);
      return;
    }
    if (this.draggedBlockId) {
      const list = event.target.closest?.("[data-editor-block-list]");
      if (!list) return;
      const target = event.target.closest("[data-editor-block]");
      if (!target || target.dataset.blockId === this.draggedBlockId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      this.clearDropIndicators();
      const rectangle = target.getBoundingClientRect();
      this.dropPosition = event.clientY < rectangle.top + rectangle.height / 2 ? "before" : "after";
      this.dropTargetId = target.dataset.blockId;
      target.classList.add(`is-drop-${this.dropPosition}`);
    }
  }

  async handleDrop(event) {
    event.preventDefault();
    if (this.draggedNodeId) {
      const draggedId = this.draggedNodeId;
      const targetId = this.dropTargetId;
      const position = this.dropPosition;
      let patch = null;
      if (position === "root-end") {
        const roots = sortByOrder(this.state.nodes.filter((node) => !node.parentId && node.id !== draggedId));
        patch = { parentId: null, ...(roots.length ? { afterId: roots.at(-1).id } : {}) };
      } else {
        const target = this.state.nodes.find((node) => node.id === targetId);
        if (target && position === "inside" && target.kind === "folder") {
          const children = sortByOrder(this.state.nodes.filter((node) => node.parentId === target.id && node.id !== draggedId));
          patch = { parentId: target.id, ...(children.length ? { afterId: children.at(-1).id } : {}) };
        } else if (target && position === "before") {
          patch = { parentId: target.parentId || null, beforeId: target.id };
        } else if (target && position === "after") {
          patch = { parentId: target.parentId || null, afterId: target.id };
        }
      }
      this.clearDragState();
      if (patch) await this.commitNodeMove(draggedId, patch);
      return;
    }
    if (this.draggedBlockId) {
      const draggedId = this.draggedBlockId;
      const targetId = this.dropTargetId;
      const position = this.dropPosition;
      this.clearDragState();
      if (!targetId || !position) return;
      if (this.editorDirty) await this.saveEditor({ quiet: true }).catch(() => {});
      try {
        await this.adapter.moveBlock(draggedId, position === "before" ? { beforeId: targetId } : { afterId: targetId });
        this.state.editorBlocks = await this.adapter.listBlocks(this.state.activeNode.id);
        this.state.activeBlocks = this.state.editorBlocks;
        await this.refreshPendingCount();
        this.render();
      } catch (error) {
        this.showToast(error.message || "블록 순서를 바꾸지 못했습니다.", "error");
      }
    }
  }

  clearDropIndicators() {
    this.root.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-inside").forEach((element) => element.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside"));
    this.root.querySelector(".structure-tree")?.classList.remove("is-drop-at-end");
    this.dropTargetId = "";
    this.dropPosition = "";
  }

  clearDragState() {
    this.root.querySelectorAll(".is-dragging").forEach((element) => element.classList.remove("is-dragging"));
    this.clearDropIndicators();
    this.draggedNodeId = "";
    this.draggedBlockId = "";
    this.dragIntent = null;
  }

  async installApp() {
    if (this.platform.isNative) return;
    if (this.deferredInstallPrompt) {
      try {
        await this.deferredInstallPrompt.prompt();
        const choice = await this.deferredInstallPrompt.userChoice;
        if (choice?.outcome === "accepted") {
          this.state.installAvailable = false;
          this.state.installDismissed = true;
        }
      } finally {
        this.deferredInstallPrompt = null;
        this.render();
      }
      return;
    }
    const dialog = this.root.querySelector("#install-dialog");
    if (typeof dialog?.showModal === "function") dialog.showModal();
    else dialog?.setAttribute("open", "");
  }

  async syncNow() {
    if (!this.state.online) {
      this.showToast("현재 오프라인입니다. 연결되면 다시 시도하세요.", "warning");
      return;
    }
    if (!this.state.settings.remoteUrl) {
      location.hash = "#/settings";
      this.showToast("먼저 집 PC 연결 정보를 입력하세요.", "warning");
      return;
    }
    this.state.syncStatus = { ...this.state.syncStatus, state: "connecting", running: true, error: null };
    this.deriveSyncPresentation();
    if (this.state.route.name !== "edit") this.render();
    try {
      await this.adapter.syncNow();
      this.showToast("PC 동기화를 시작했습니다.", "success");
    } catch (error) {
      this.state.syncStatus = { ...this.state.syncStatus, state: "error", running: false, error: { message: error.message } };
      this.deriveSyncPresentation();
      this.showToast(error.message || "PC와 동기화하지 못했습니다.", "error");
    }
  }

  async toggleSync() {
    if (this.adapter.syncController?.running) {
      await this.adapter.stopSync();
      this.state.syncStatus = { ...DEFAULT_SYNC_STATUS, state: "stopped" };
      this.deriveSyncPresentation();
      this.showToast("자동 동기화를 일시 정지했습니다.", "warning");
      return;
    }
    await this.syncNow();
  }

  async exportData() {
    try {
      const payload = await this.adapter.exportData();
      const text = JSON.stringify(payload, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `Title-Placeholder-Wiki-${date}.json`;
      const file = new File([text], filename, { type: "application/json" });

      if (this.platform.kind === "android" && this.platform.isNative) {
        const saved = await Filesystem.writeFile({
          path: filename,
          data: utf8ToBase64(text),
          directory: Directory.Cache,
          recursive: true,
        });
        const uri = saved?.uri || (await Filesystem.getUri({ path: filename, directory: Directory.Cache }))?.uri;
        if (uri) {
          await Share.share({
            title: "Title Placeholder Wiki 백업",
            text: "개인 위키 전체 백업 파일",
            files: [uri],
            dialogTitle: "백업 파일 저장 또는 공유",
          });
          this.showToast("Android 공유 화면에 백업 파일을 전달했습니다.", "success");
          return;
        }
      }

      if (this.platform.kind === "android" && navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "Title Placeholder Wiki 백업",
          text: "개인 위키 전체 백업 파일",
        });
        this.showToast("Android 공유 화면에 백업 파일을 전달했습니다.", "success");
        return;
      }

      const blobUrl = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = filename;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
      this.showToast(this.platform.kind === "android" ? "백업 다운로드를 요청했습니다. 파일 앱의 다운로드 폴더를 확인하세요." : "전체 백업 파일을 내보냈습니다.", "success");
    } catch (error) {
      if (error?.name === "AbortError") return;
      this.showToast(error.message || "백업 파일을 만들지 못했습니다.", "error");
    }
  }

  async importData(file) {
    if (file.size > 128 * 1024 * 1024) {
      this.showToast("백업 파일이 너무 큽니다. 128MB 이하 JSON 파일을 사용하세요.", "error");
      return;
    }
    const strategy = this.root.querySelector("#import-strategy")?.value || "merge";
    if (strategy === "replace") {
      const approved = typeof window.confirm !== "function" || window.confirm("현재 로컬 기록을 백업 파일 기준으로 교체합니다. 가져오기는 파일 전체를 먼저 검증하며, 오류가 나면 기존 데이터는 그대로 유지됩니다. 계속할까요?");
      if (!approved) return;
    }
    try {
      let text;
      if (/\.gz$/i.test(file.name) || file.type === "application/gzip") {
        if (typeof DecompressionStream !== "function") {
          throw new Error("이 기기에서는 압축 백업을 직접 열 수 없습니다. PC에서 압축을 푼 JSON 파일을 선택하세요.");
        }
        const decompressed = file.stream().pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(decompressed).text();
      } else {
        text = await file.text();
      }
      await this.adapter.importData(text, strategy);
      await Promise.all([this.reloadNodes(), this.refreshPendingCount(), this.refreshStorageEstimate()]);
      this.showToast(strategy === "replace" ? "백업으로 로컬 기록을 교체했습니다." : "백업 기록을 현재 아카이브와 합쳤습니다.", "success");
      if (this.state.route.name !== "home") location.hash = "#/home";
      else await this.loadRoute({ focusMain: true, skipFlush: true });
    } catch (error) {
      this.showToast(`${error.message || "백업을 가져오지 못했습니다."} 기존 데이터는 변경하지 않았습니다.`, "error");
    }
  }

  async resolveConflict(id, winner) {
    try {
      await this.adapter.resolveConflict(id, winner);
      this.state.conflicts = await this.adapter.listConflicts();
      await Promise.all([this.reloadNodes(), this.refreshPendingCount()]);
      this.showToast(winner === "merge" ? "두 버전을 각각 보관했습니다." : "선택한 버전으로 충돌을 해결했습니다.", "success");
    } catch (error) {
      this.showToast(error.message || "충돌을 해결하지 못했습니다.", "error");
    }
  }

  previewRevision(id) {
    const revision = this.state.revisions.find((item) => item.id === id);
    if (!revision) return;
    const dialog = document.createElement("dialog");
    dialog.className = "modal revision-preview-modal";
    const surface = document.createElement("div");
    surface.className = "modal__surface";
    const header = document.createElement("header");
    const heading = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "REVISION SNAPSHOT";
    const title = document.createElement("h2");
    title.textContent = revision.reason || "저장된 버전";
    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.setAttribute("aria-label", "미리보기 닫기");
    close.textContent = "×";
    close.addEventListener("click", () => dialog.close());
    heading.append(eyebrow, title);
    header.append(heading, close);
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(revision.snapshot || revision, null, 2);
    surface.append(header, pre);
    dialog.append(surface);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  async restoreRevision(id) {
    const approved = typeof window.confirm !== "function" || window.confirm("현재 상태를 먼저 이력에 저장한 뒤 이 버전을 새 초안으로 복원할까요?");
    if (!approved) return;
    try {
      await this.adapter.restoreRevision(id);
      await Promise.all([this.reloadNodes(), this.refreshPendingCount()]);
      this.showToast("선택한 버전을 현재 초안으로 복원했습니다.", "success");
      location.hash = `#/edit/${this.state.activeNode.id}`;
    } catch (error) {
      this.showToast(error.message || "이 버전을 복원하지 못했습니다.", "error");
    }
  }

  async openExternal(value) {
    const url = safeExternalUrl(value);
    if (!url) {
      this.showToast("안전한 http 또는 https 링크만 열 수 있습니다.", "error");
      return;
    }
    try {
      const nativeBrowser = window.Capacitor?.Plugins?.Browser;
      if (this.platform.kind === "android" && nativeBrowser?.open) {
        await nativeBrowser.open({ url });
        return;
      }
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (opened) opened.opener = null;
    } catch (error) {
      this.showToast(error.message || "외부 링크를 열지 못했습니다.", "error");
    }
  }

  toggleSecret(targetId, button) {
    const field = this.root.querySelector(`#${CSS.escape(targetId)}`);
    if (!field) return;
    field.type = field.type === "password" ? "text" : "password";
    button.textContent = field.type === "password" ? "보기" : "숨기기";
  }

  async copyField(targetId) {
    const field = this.root.querySelector(`#${CSS.escape(targetId)}`);
    if (!field) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("클립보드를 사용할 수 없습니다.");
      await navigator.clipboard.writeText(field.value || field.textContent || "");
      this.showToast("클립보드에 복사했습니다.", "success");
    } catch (error) {
      this.showToast(error.message, "error");
    }
  }

  async configureTailscale() {
    if (!window.desktopBridge?.configureTailscale) return;
    try {
      const result = await window.desktopBridge.configureTailscale();
      if (!result?.ok) throw new Error(result?.error || "Tailscale 주소를 만들지 못했습니다.");
      await this.loadRuntimeInfo();
      this.showToast("Tailscale 개인망 주소를 설정했습니다.", "success");
    } catch (error) {
      this.showToast(error.message, "error");
    }
  }

  async setDesktopAutoStart(enabled) {
    if (!window.desktopBridge?.setAutoStart) return;
    try {
      const active = await window.desktopBridge.setAutoStart(Boolean(enabled));
      this.state.runtimeInfo = { ...this.state.runtimeInfo, autoStart: Boolean(active) };
      this.render();
      this.showToast(active ? "Windows 로그인 시 자동 시작을 켰습니다." : "Windows 자동 시작을 껐습니다.", "success");
    } catch (error) {
      this.state.runtimeInfo = { ...this.state.runtimeInfo, autoStart: !enabled };
      this.render();
      this.showToast(error.message || "자동 시작 설정을 변경하지 못했습니다.", "error");
    }
  }

  async createDesktopBackup() {
    if (!window.desktopBridge?.createBackup) return;
    try {
      await window.desktopBridge.createBackup();
      this.showToast("PC 백업 파일을 만들었습니다.", "success");
    } catch (error) {
      this.showToast(error.message || "PC 백업을 만들지 못했습니다.", "error");
    }
  }

  async openBackupFolder() {
    if (!window.desktopBridge?.openBackupFolder) return;
    try {
      await window.desktopBridge.openBackupFolder();
    } catch (error) {
      this.showToast(error.message || "백업 폴더를 열지 못했습니다.", "error");
    }
  }
}

export async function createAppController(options) {
  return new AppController(options);
}
