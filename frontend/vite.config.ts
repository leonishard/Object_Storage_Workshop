import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward /upload and /gallery to the backend so we don't hit CORS in dev
      "/upload": "http://localhost:3001",
      "/gallery": "http://localhost:3001",
    },
  },
});
