import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  const token = process.env.SCENESPARROW_SESSION_TOKEN;
  if (command === "serve" && !token)
    throw new Error("Start the workspace with pnpm dev");
  return {
    plugins: [
      react(),
      {
        name: "scenesparrow-safe-build",
        transformIndexHtml() {
          const candidate = process.env.SCENESPARROW_BUILD_SHA ?? "";
          const content = /^[a-f0-9]{7,40}$/.test(candidate)
            ? candidate
            : "unknown";
          return [
            {
              tag: "meta",
              attrs: { name: "scenesparrow-build", content },
              injectTo: "head-prepend" as const,
            },
          ];
        },
      },
    ],
    base: "./",
    preview: {
      host: "127.0.0.1",
      port: Number(process.env.SCENESPARROW_WEB_PORT ?? 5173),
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${process.env.SCENESPARROW_CORE_PORT ?? 4318}`,
          rewrite: (path) => path.replace(/^\/api/, ""),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    server: {
      host: "127.0.0.1",
      port: Number(process.env.SCENESPARROW_WEB_PORT ?? 5173),
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${process.env.SCENESPARROW_CORE_PORT ?? 4318}`,
          rewrite: (path) => path.replace(/^\/api/, ""),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
  };
});
