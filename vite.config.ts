import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";
import { createHash } from "crypto";

const BUILD_VERSION = (
  process.env.BUILD_VERSION ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.REPL_DEPLOYMENT_ID ||
  createHash("sha256").update(String(Date.now())).digest("hex")
).slice(0, 12);

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    hmr: {
      overlay: false,
    },
    allowedHosts: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Household OS",
        short_name: "Household OS",
        description: "AI-orchestrated residential estate operating system",
        theme_color: "#1c1917",
        background_color: "#1c1917",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
          {
            src: "/icon.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,ico,png,webp,svg,woff2}"],
        navigateFallback: null,
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Navigation requests (HTML shells) must NEVER be served from SW
            // cache — a stale shell references hashed chunks that vanish after
            // each deploy, which is the primary cause of "Couldn't load this
            // page" errors. The server (Cloudflare _headers + _worker.js)
            // already sends no-cache/no-store on all HTML responses, so caching
            // them in the SW is both unnecessary and harmful. Use NetworkOnly so
            // the browser always fetches the live shell and any deploy-time
            // chunk mismatch is eliminated at the source.
            urlPattern: ({ request }: { request: Request }) => request.mode === "navigate",
            handler: "NetworkOnly",
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-cache",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "gstatic-fonts-cache",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ].filter(Boolean),
  build: {
    outDir: "dist/public",
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes("node_modules")) return;
          if (
            id.includes("/react-router-dom/") ||
            id.includes("/react-router/") ||
            id.includes("/react-dom/") ||
            id.includes("/react/") ||
            id.includes("/scheduler/")
          )
            return "vendor-react";
          if (id.includes("/@tanstack/react-query/")) return "vendor-query";
          if (id.includes("/recharts/")) return "vendor-charts";
          if (id.includes("/date-fns/")) return "vendor-dates";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
      "@assets": path.resolve(__dirname, "./attached_assets"),
    },
  },
}));
