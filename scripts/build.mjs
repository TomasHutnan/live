// Bundles the server and the browser code. Everything lands in dist/.
import { build } from "esbuild";

await build({
  entryPoints: { server: "src/server/index.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  sourcemap: true,
  logLevel: "warning",
});

await build({
  entryPoints: {
    "live-client": "src/client/live-client.ts",
    "export-runtime": "src/client/export-runtime.ts",
    dashboard: "src/client/dashboard.ts",
  },
  outdir: "dist/public",
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2021", "safari15"],
  loader: { ".css": "text" },
  logLevel: "warning",
});
