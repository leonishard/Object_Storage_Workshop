import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Backend routes
      "/upload":         "http://localhost:3001",
      "/gallery":        "http://localhost:3001",
      "/presign-upload": "http://localhost:3001",
      "/objects":        "http://localhost:3001",

      // MinIO direct-upload proxy — forwards browser PUT requests to MinIO,
      // bypassing the CORS restriction that blocks cross-origin requests from :5173 to :9000.
      // changeOrigin rewrites the Host header to localhost:9000 so the presigned
      // URL signature check still passes.
      "/minio-direct": {
        target:       "http://localhost:9000",
        changeOrigin: true,
        rewrite:      (path) => path.replace(/^\/minio-direct/, ""),
      },
    },
  },
});
