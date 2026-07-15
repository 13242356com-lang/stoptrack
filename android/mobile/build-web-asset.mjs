// Produce the WebView asset for the phone app: android/mobile/src/main/assets/index.html
//
// Starts from the built ../../index.html (the full StopTrack web app) and inlines
// the React + Tailwind CDN <script src> tags so the app works with NO internet on
// the factory floor. If a CDN can't be fetched (offline build), it leaves that tag
// as-is — the app then fetches it on first launch, like the plain web app.
//
// Run from the repo root: `node android/mobile/build-web-asset.mjs`
// (the Gradle `prepareWebAsset` task does this automatically).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repoRoot = process.cwd();
const src = resolve(repoRoot, "index.html");
const out = resolve(repoRoot, "android/mobile/src/main/assets/index.html");

const html = await readFile(src, "utf8");

// Match <script ... src="https://..."></script> (React UMD, Tailwind CDN).
const scriptTag = /<script\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*><\/script>/g;

let inlined = 0;
let failed = 0;
const tags = [...html.matchAll(scriptTag)];
let result = html;

for (const match of tags) {
  const [fullTag, url] = match;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let code = await res.text();
    // Guard against an accidental </script> inside inlined code closing our tag.
    code = code.replaceAll("</script>", "<\\/script>");
    // IMPORTANT: use split/join, NOT String.replace — a replacement string
    // interprets `$$`, `$&`, `$1`… and React's minified code is full of `$$typeof`
    // and `$`-sequences, which .replace() would corrupt (→ React error #31).
    result = result.split(fullTag).join(`<script>${code}</script>`);
    inlined++;
    console.log(`inlined ${url} (${code.length} bytes)`);
  } catch (e) {
    failed++;
    console.warn(`could not inline ${url}: ${e.message} — leaving CDN reference`);
  }
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, result, "utf8");
console.log(`wrote ${out} — ${inlined} inlined, ${failed} left as CDN (${result.length} bytes)`);
