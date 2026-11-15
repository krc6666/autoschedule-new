import { defineConfig } from "vitest/config";
import { readCloudConfiguration } from "./src/infrastructure/supabase-config";

export default defineConfig({
  plugins: [
    {
      name: "validate-cloud-configuration",
      configResolved(config) {
        // Vite has resolved mode-specific files and process overrides here.
        // Reject private keys before any browser bundle can be written.
        readCloudConfiguration(config.env);
      },
    },
  ],
  base: "./",
  optimizeDeps: {
    exclude: ["@autoschedule/highs-ts", "@bubblyworld/highs-ts"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 900,
  },
  worker: {
    format: "es",
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
