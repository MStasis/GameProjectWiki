import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      events: "events/",
    },
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null,
      manifest: false,
      workbox: {
        navigateFallback: "index.html",
        globPatterns: ["**/*.{html,css,js,json,png,webp,ico,woff2}"],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true
      }
    })
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022"
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.js"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
