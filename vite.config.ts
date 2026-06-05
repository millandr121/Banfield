import { defineConfig } from "vite";

// The client is a static HTML5 Canvas app. In dev, Vite serves it on :5173 and
// proxies the WebSocket connection to `wrangler dev` (the Worker) on :8787.
// In production, `wrangler deploy` serves the built files from dist/client.
export default defineConfig({
  root: "client",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
});
