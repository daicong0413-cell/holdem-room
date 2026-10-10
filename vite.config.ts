import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

/**
 * The client is a single page that talks to the game server over `/ws`.
 * In development Vite serves the page and proxies the socket and the small
 * REST surface to the Node server, so `npm run dev:web` + `npm start` behaves
 * exactly like the production build served by `main.ts`.
 */
export default defineConfig({
  root: resolve(root, "src/web"),
  plugins: [react()],
  build: {
    outDir: resolve(root, "dist/web"),
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      "/api": { target: "http://127.0.0.1:8787" },
    },
  },
});
