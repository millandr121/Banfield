import { defineConfig, Plugin } from "vite";
import { resolve } from "node:path";
import fs from "node:fs";
import path from "node:path";

// Dev-only plugin: POST /api/save-asset  { filename: "foo.json", data: {...} }
// writes to client/src/assets/<filename> so Vite hot-reloads the change.
function saveAssetPlugin(): Plugin {
  return {
    name: "save-asset",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/save-asset", (req, res, next) => {
        if (req.method !== "POST") return next();
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          try {
            const { filename, data } = JSON.parse(body) as { filename: string; data: unknown };
            const safe = path.basename(filename);   // no path traversal
            const dest = path.resolve(__dirname, "client/src/assets", safe);
            fs.writeFileSync(dest, JSON.stringify(data, null, 2));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  root: "client",
  plugins: [saveAssetPlugin()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "client/index.html"),
        editor: resolve(__dirname, "client/editor.html"),
      },
    },
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
