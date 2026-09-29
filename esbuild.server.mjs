import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  packages: "external",
  external: ["vite"],
  banner: {
    js: `
import { createRequire as __createRequire } from 'module';
const require = __createRequire(import.meta.url);
`,
  },
});

await build({
  entryPoints: ["scripts/run-migrations.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/run-migrations.js",
  packages: "external",
  banner: {
    js: `
import { createRequire as __createRequire } from 'module';
const require = __createRequire(import.meta.url);
`,
  },
});

console.log("Server & migrations built → dist/index.js, dist/run-migrations.js");
