// StopTrack build: StopTrack.tsx -> single self-contained index.html.
//
// Pipeline (the documented one, made reproducible & committed):
//   build/head.html  +  tsc( "@ts-nocheck" + build/icons.js + StopTrack.tsx
//                             with its import/export lines stripped )  +  build/tail.html
//
// The head / icon-prelude / tail are STATIC committed scaffold, so this build
// does not depend on a prior index.html — a fresh clone (or CI) rebuilds cleanly.
// Output is written to index.html (the committed artifact) and dist/index.html
// (Cloudflare Pages' output directory). LF line endings, deterministic for a
// pinned TypeScript version.
import fs from "node:fs";
import cp from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUILD = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BUILD, "..");
const TSX = path.join(ROOT, "StopTrack.tsx");

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// --- 1) Static scaffold (committed) ----------------------------------------
const head = read(path.join(BUILD, "head.html"));
const icons = read(path.join(BUILD, "icons.js"));
const tail = read(path.join(BUILD, "tail.html"));
if (!head.trimEnd().endsWith("<script>")) throw new Error("build/head.html must end with the app <script> tag");
if (!/PencilLine = I\(/.test(icons)) throw new Error("build/icons.js is missing the inline icon set");
if (!tail.startsWith("(function () {")) throw new Error("build/tail.html must start with the mount IIFE");

// --- 2) Strip imports/exports from the TSX app body ------------------------
let tsx = read(TSX);
tsx = tsx.replace(/^import\s*\{[\s\S]*?\}\s*from\s*"react";\s*\n/, "");
tsx = tsx.replace(/^import\s*\{[\s\S]*?\}\s*from\s*"lucide-react";\s*\n/m, "");
tsx = tsx.replace(/export default function App/, "function App");
tsx = tsx.replace(/export const STORAGE_INFO/, "const STORAGE_INFO");
if (/^import\s/m.test(tsx)) throw new Error("leftover import in stripped tsx");
if (/^export\s/m.test(tsx)) throw new Error("leftover export in stripped tsx");

// --- 3) Transpile JSX -> React.createElement with tsc ----------------------
// @ts-nocheck: transpile-only. The source references CDN globals (React) and
// uses loose prop shapes; type errors are irrelevant and emit is unaffected.
const buildSrc = path.join(BUILD, "build_src.tsx");
fs.writeFileSync(buildSrc, "// @ts-nocheck\n" + icons + "\n\n" + tsx, "utf8");

const tscBin = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const appJsPath = path.join(BUILD, "app.js");
fs.rmSync(appJsPath, { force: true });
const res = cp.spawnSync(process.execPath, [
  tscBin, buildSrc,
  "--jsx", "react", "--jsxFactory", "React.createElement", "--jsxFragmentFactory", "React.Fragment",
  "--target", "es2017", "--module", "none", "--lib", "es2017,dom", "--alwaysStrict",
  "--skipLibCheck", "--noResolve", "--allowJs", "--removeComments", "--ignoreDeprecations", "5.0",
  "--outFile", appJsPath,
], { encoding: "utf8" });
if (res.stderr && res.stderr.trim()) console.log(res.stderr.trim());
// tsc emits even with (irrelevant) type errors; only fail if nothing was produced.
if (!fs.existsSync(appJsPath)) throw new Error("tsc produced no app.js (exit " + res.status + ")");
const appJs = read(appJsPath);

// --- 4) Assemble + write both artifacts ------------------------------------
const finalHtml = head.replace(/\s*$/, "") + "\n" + appJs.replace(/\s*$/, "") + "\n\n" + tail.replace(/^\n+/, "");

// --- 5) Gate checks (fail the build on regressions) ------------------------
const scriptJs = finalHtml.slice(finalHtml.indexOf('"use strict";'), finalHtml.lastIndexOf("</script>"));
const jsx = scriptJs.match(/<[A-Z][a-zA-Z]+/g) || [];
if (jsx.length) throw new Error("leftover JSX in output: " + jsx.slice(0, 5).join(", "));
if (/\?\?/.test(scriptJs)) throw new Error("raw ?? survived to output (target es2017 should remove it)");
if (/\?\./.test(scriptJs)) throw new Error("raw ?. survived to output");

fs.writeFileSync(path.join(ROOT, "index.html"), finalHtml, "utf8");
const dist = path.join(ROOT, "dist");
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), finalHtml, "utf8");
fs.rmSync(buildSrc, { force: true });
fs.rmSync(appJsPath, { force: true });
console.log(`Built index.html (${finalHtml.length} bytes) + dist/index.html — gates passed (no JSX, no ??/?.).`);
