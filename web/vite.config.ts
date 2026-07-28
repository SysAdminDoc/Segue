import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy the API to the backend so the browser sees one origin (keeps the
// session cookie same-site). In prod the backend serves the built SPA directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});
