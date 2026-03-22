import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const sharedFrontendRoot = path.resolve(__dirname, "../frontend");

export default defineConfig({
  root: sharedFrontendRoot,
  envDir: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(sharedFrontendRoot, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "./dist"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4293,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8789",
        changeOrigin: true,
        rewrite: (value) => value.replace(/^\/api/, ""),
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4293,
  },
});
