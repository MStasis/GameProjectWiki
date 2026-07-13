import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { createAppController } from "./ui/app-controller.js";

const root = document.querySelector("#app");
const announcer = document.querySelector("#live-announcer");

async function start() {
  if (!root) return;

  try {
    const controller = await createAppController({ root, announcer });
    await controller.start();
    window.wikiApp = controller;
  } catch (error) {
    console.error("위키 앱을 시작하지 못했습니다.", error);
    root.className = "fatal-shell";
    root.removeAttribute("aria-busy");
    root.innerHTML = `
      <main class="fatal-card">
        <span class="eyebrow">STARTUP INTERRUPTED</span>
        <h1>로컬 저장소를 열지 못했습니다</h1>
        <p>앱을 완전히 닫았다가 다시 열어 주세요. 문제가 계속되면 설정에서 백업 파일을 가져올 수 있습니다.</p>
        <button class="button button--primary" type="button" id="retry-start">다시 시도</button>
        <details><summary>오류 정보</summary><pre>${String(error?.message || error)}</pre></details>
      </main>`;
    root.querySelector("#retry-start")?.addEventListener("click", () => window.location.reload());
  }
}

start();

const isNativeShell = Boolean(
  window.desktopBridge
  || window.Capacitor?.isNativePlatform?.()
  || /\bElectron\b/i.test(navigator.userAgent),
);

if ("serviceWorker" in navigator && window.isSecureContext && !isNativeShell) {
  registerSW({ immediate: true });
} else if ("serviceWorker" in navigator && isNativeShell) {
  // Older development builds registered the PWA worker inside native shells.
  // Remove those registrations/caches so packaged updates always load bundled
  // assets; IndexedDB wiki content is not part of Cache Storage and is kept.
  void navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => {});
  if ("caches" in window) {
    void caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => /workbox|local-archive|precache/i.test(key))
        .map((key) => caches.delete(key))))
      .catch(() => {});
  }
}
