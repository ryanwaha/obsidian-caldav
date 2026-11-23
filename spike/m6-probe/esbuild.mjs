import esbuild from "esbuild";
await esbuild.build({
  entryPoints: [new URL("./main.ts", import.meta.url).pathname],
  bundle: true, format: "cjs", target: "es2022",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  outfile: process.argv[2],
});
