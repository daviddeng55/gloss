import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Default layout: src/main (main process), src/preload, src/renderer (windows).
export default defineConfig({
  main: {
    build: { rollupOptions: { external: ["node:sqlite"] } },
  },
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
