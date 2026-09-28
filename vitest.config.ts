import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    projects: [
      {
        plugins: [react()],
        test: {
          name: "frontend",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.{test,spec}.{ts,tsx}"],
        },
        resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
      },
      {
        test: {
          name: "server",
          environment: "node",
          globals: true,
          setupFiles: ["./server/test/setup.ts"],
          include: [
            "server/**/__tests__/*.{test,spec}.ts",
            "scripts/__tests__/*.{test,spec}.ts",
          ],
        },
        resolve: {
          alias: { "@shared": path.resolve(__dirname, "./shared") },
        },
      },
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
