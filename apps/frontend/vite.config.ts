import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const DEFAULT_FRONTEND_ENV = {
  VITE_SITE_NAME: "alpha book",
  VITE_SITE_DESCRIPTION: "Search, read, and ask questions across a growing library of books with cited answers.",
  VITE_THEME_COLOR: "#323a85",
  VITE_SITE_ORIGIN: "https://alpha-book.org",
  VITE_OG_IMAGE_URL: "https://alpha-book.org/social-card.jpg",
} as const;

function htmlEnvFallbackPlugin(): PluginOption {
  return {
    name: "alphabook-html-env-fallback",
    transformIndexHtml(html, context) {
      const env = loadEnv(context.server?.config.mode ?? "production", process.cwd(), "");
      const resolved = {
        VITE_SITE_NAME: env.VITE_SITE_NAME || DEFAULT_FRONTEND_ENV.VITE_SITE_NAME,
        VITE_SITE_DESCRIPTION: env.VITE_SITE_DESCRIPTION || DEFAULT_FRONTEND_ENV.VITE_SITE_DESCRIPTION,
        VITE_THEME_COLOR: env.VITE_THEME_COLOR || DEFAULT_FRONTEND_ENV.VITE_THEME_COLOR,
        VITE_SITE_ORIGIN: env.VITE_SITE_ORIGIN || DEFAULT_FRONTEND_ENV.VITE_SITE_ORIGIN,
        VITE_OG_IMAGE_URL: env.VITE_OG_IMAGE_URL || DEFAULT_FRONTEND_ENV.VITE_OG_IMAGE_URL,
      };

      return html.replace(/%VITE_[A-Z0-9_]+%/gu, (token) => resolved[token.slice(1, -1) as keyof typeof resolved] ?? token);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), tailwindcss(), htmlEnvFallbackPlugin()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 4193,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:8788",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 4193,
    },
    define: {
      "import.meta.env.VITE_SITE_NAME": JSON.stringify(env.VITE_SITE_NAME || DEFAULT_FRONTEND_ENV.VITE_SITE_NAME),
      "import.meta.env.VITE_SITE_DESCRIPTION": JSON.stringify(env.VITE_SITE_DESCRIPTION || DEFAULT_FRONTEND_ENV.VITE_SITE_DESCRIPTION),
      "import.meta.env.VITE_THEME_COLOR": JSON.stringify(env.VITE_THEME_COLOR || DEFAULT_FRONTEND_ENV.VITE_THEME_COLOR),
      "import.meta.env.VITE_SITE_ORIGIN": JSON.stringify(env.VITE_SITE_ORIGIN || DEFAULT_FRONTEND_ENV.VITE_SITE_ORIGIN),
      "import.meta.env.VITE_OG_IMAGE_URL": JSON.stringify(env.VITE_OG_IMAGE_URL || DEFAULT_FRONTEND_ENV.VITE_OG_IMAGE_URL),
    },
  };
});
