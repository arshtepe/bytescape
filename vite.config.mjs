import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5179,
    proxy: {
      "/api": "http://127.0.0.1:5178",
      "/mcp": "http://127.0.0.1:5178",
      "/ws": {
        target: "ws://127.0.0.1:5178",
        ws: true
      }
    }
  }
});
