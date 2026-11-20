import { build } from "vite";
await build({
  configFile: false,
  base: "./",
  build: {
    target: "es2022",
    outDir: ".tmp/flight-identities/production",
    emptyOutDir: true,
    rollupOptions: { input: ".tmp/flight-identities/browser.html" },
  },
  worker: { format: "es" },
});
