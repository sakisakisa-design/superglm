import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the React dashboard from worker/web/index.html into dist/client,
// which Wrangler serves as static assets for the Worker.
export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: {
    alias: {
      "@web": new URL("./web", import.meta.url).pathname,
    },
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    sourcemap: true,
  },
});
