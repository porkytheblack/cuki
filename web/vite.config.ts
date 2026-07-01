import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Built to web/dist, then copied to src/http/assets and embedded in the binary (design 08).
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Single bundle keeps the embedded-asset manifest small and predictable.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/healthz": "http://127.0.0.1:8787",
    },
  },
})
