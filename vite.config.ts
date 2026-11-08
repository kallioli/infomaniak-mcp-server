import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "admin-ui",
  plugins: [react()],
  // The logo files are shared with the MCP endpoint, which serves them to clients such as claude.ai.
  publicDir: "../assets",
  build: { outDir: "../dist/admin-ui", emptyOutDir: true },
  // `npm run dev:admin` proxies the API to a locally running server (ADMIN_PORT=9090).
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:9090" } },
});
