// Checks the built site: internal links resolve, every page exists in both languages with the right
// <html lang>, nothing is loaded from another host, each page has a title and a description, and
// the English and Turkish copy have exactly the same keys.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!process.argv.includes("--no-build")) execFileSync(process.execPath, [join(root, "node_modules", "astro", "bin", "astro.mjs"), "build"], { cwd: root, stdio: "ignore" });

const problems = [];
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const html = walk(dist).filter((f) => f.endsWith(".html"));
const urlOf = (f) => "/" + relative(dist, f).replace(/\\/g, "/").replace(/index\.html$/, "");

const exists = (url) => {
  const path = decodeURI(url.split("#")[0].split("?")[0]);
  const p = join(dist, path);
  return existsSync(p) && (statSync(p).isFile() || existsSync(join(p, "index.html")));
};

for (const f of html) {
  const url = urlOf(f);
  const s = readFileSync(f, "utf8");
  const lang = /<html[^>]*lang="(\w+)"/.exec(s)?.[1];
  const want = url.startsWith("/tr/") ? "tr" : "en";
  if (lang !== want) problems.push(`${url}: <html lang="${lang}">, expected ${want}`);
  if (!/<title>[^<]{10,}<\/title>/.test(s)) problems.push(`${url}: missing title`);
  if (!/<meta name="description" content="[^"]{40,}"/.test(s)) problems.push(`${url}: missing description`);
  if (!["/", "/tr/"].includes(url) && !/<p\b[^>]*class="eyebrow"[^>]*>[^<]+<\/p>\s*<h1\b/.test(s)) problems.push(`${url}: missing page eyebrow before title`);
  const twin = want === "en" ? `/tr${url}` : url.slice(3);
  if (!exists(twin)) problems.push(`${url}: no ${want === "en" ? "Turkish" : "English"} version at ${twin}`);
  for (const [, attr, value] of s.matchAll(/\s(href|src)="([^"]+)"/g)) {
    if (/^(mailto:|#|data:)/.test(value)) continue;
    if (/^https?:\/\//.test(value) || value.startsWith("//")) {
      // Plain links to the source repository are fine; nothing may be loaded from another host.
      const allowed = ["https://github.com/Mehmet274634/baglam", "https://nodejs.org", "https://brew.sh", "https://github.com/nvm-sh/nvm"];
      const repoLink = attr === "href" && allowed.some((a) => value.startsWith(a)) && new RegExp(`<a [^>]*href="${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(s);
      if (!repoLink) problems.push(`${url}: loads or links to another host: ${attr}="${value}"`);
      continue;
    }
    if (value.startsWith("/") && !exists(value)) problems.push(`${url}: broken link ${value}`);
    if (want === "tr" && attr === "href" && value.startsWith("/") && !value.startsWith("/tr/") && !value.startsWith("/_astro/") && !/\.(svg|css|js|woff2?)$/.test(value)) {
      const isSwitch = new RegExp(`href="${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*hreflang="en"`).test(s);
      if (!isSwitch) problems.push(`${url}: Turkish page links to English page ${value}`);
    }
  }
}

// Same keys in both languages.
const { en } = await import(pathToFileURL(join(root, "src", "i18n", "en.ts")).href);
{
  const { tr } = await import(pathToFileURL(join(root, "src", "i18n", "tr.ts")).href);
  const shape = (o, p = "") =>
    Array.isArray(o) ? [`${p}[${o.length}]`, ...o.flatMap((x, i) => shape(x, `${p}[${i}]`))] : o && typeof o === "object" ? Object.keys(o).sort().flatMap((k) => [`${p}.${k}`, ...shape(o[k], `${p}.${k}`)]) : [];
  const a = new Set(shape(en));
  const b = new Set(shape(tr));
  for (const k of a) if (!b.has(k)) problems.push(`tr.ts is missing ${k}`);
  for (const k of b) if (!a.has(k)) problems.push(`tr.ts has extra ${k}`);
}

console.log(`${html.length} pages checked`);
if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`);
  process.exit(1);
}
console.log("✓ all checks passed");
