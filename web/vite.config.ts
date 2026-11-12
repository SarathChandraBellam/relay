import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser talks to one origin. Vite forwards /api to a relay server.
// Point RELAY_SERVER at a different instance to see that any server will do.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { "/api": { target: process.env.RELAY_SERVER ?? "http://localhost:4000", changeOrigin: true } },
  },
});
