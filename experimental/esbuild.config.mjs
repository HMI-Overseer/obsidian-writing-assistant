import esbuild from "esbuild";
import builtins from "builtin-modules";

await esbuild.build({
  entryPoints: ["experimental/cli.ts"],
  outfile: "experimental/.build/cli.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  treeShaking: true,
  external: [
    ...builtins,
    ...builtins.map((moduleName) => `node:${moduleName}`),
  ],
});
