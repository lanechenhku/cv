#!/usr/bin/env node
/**
 * Export the single-file CV site to two A4 PDFs (EN + ZH).
 *
 * index.html carries its own print stylesheet (@media print), so this script
 * only switches the language and prints — the PDF never drifts from the page.
 *
 * Fonts: Chromium writes web fonts delivered as WOFF2 into the PDF as Type3
 * glyph procedures, which makes the text layer break mid-word. Fetching the
 * same families as plain TTF (the CSS API answers with format('truetype') when
 * no browser UA is sent) makes Chromium embed them as CIDFontType2 with a
 * ToUnicode map, so the PDF stays selectable and searchable.
 *
 * Usage:
 *   NODE_PATH=/Users/lanechen/Desktop/2HAI_v3/node_modules node tools/make-cv-pdf.mjs
 *
 * Output:
 *   assets/Lane_Chen_CV_EN.pdf
 *   assets/Lane_Chen_CV_ZH.pdf
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// NODE_PATH is only honoured by CommonJS resolution, so go through createRequire
// instead of a bare ESM import of the package.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_URL = pathToFileURL(path.join(ROOT, "index.html")).href;
const FONT_CACHE = path.join(os.homedir(), ".cache", "lanechen-cv-fonts");

const TARGETS = [
  { lang: "en", file: "assets/Lane_Chen_CV_EN.pdf" },
  { lang: "zh", file: "assets/Lane_Chen_CV_ZH.pdf" }
];

// One entry per (family, weight): Chromium writes a variable font instance as
// Type3 glyph procedures, but a static face is embedded as CIDFontType2.
const FONT_SPECS = [
  { family: "Inter", weight: 300, query: "Inter:wght@300", file: "inter-300.ttf" },
  { family: "Inter", weight: 400, query: "Inter:wght@400", file: "inter-400.ttf" },
  { family: "Inter", weight: 500, query: "Inter:wght@500", file: "inter-500.ttf" },
  { family: "Inter", weight: 600, query: "Inter:wght@600", file: "inter-600.ttf" },
  { family: "Inter", weight: 700, query: "Inter:wght@700", file: "inter-700.ttf" },
  { family: "Inter", weight: 800, query: "Inter:wght@800", file: "inter-800.ttf" },
  { family: "Space Grotesk", weight: 500, query: "Space+Grotesk:wght@500", file: "space-grotesk-500.ttf" },
  { family: "Space Grotesk", weight: 600, query: "Space+Grotesk:wght@600", file: "space-grotesk-600.ttf" },
  { family: "Space Grotesk", weight: 700, query: "Space+Grotesk:wght@700", file: "space-grotesk-700.ttf" },
  { family: "Noto Sans SC", weight: 400, query: "Noto+Sans+SC:wght@400", file: "noto-sans-sc-400.ttf" },
  { family: "Noto Sans SC", weight: 500, query: "Noto+Sans+SC:wght@500", file: "noto-sans-sc-500.ttf" },
  { family: "Noto Sans SC", weight: 700, query: "Noto+Sans+SC:wght@700", file: "noto-sans-sc-700.ttf" }
];

async function ensureFontTtf(spec) {
  const dest = path.join(FONT_CACHE, spec.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) return dest;
  fs.mkdirSync(FONT_CACHE, { recursive: true });
  const css = await (await fetch("https://fonts.googleapis.com/css2?family=" + spec.query)).text();
  const hit = /src:\s*url\((https:[^)]+\.ttf)\)/.exec(css);
  if (!hit) throw new Error("no ttf url for " + spec.family);
  const bytes = Buffer.from(await (await fetch(hit[1])).arrayBuffer());
  fs.writeFileSync(dest, bytes);
  console.log("  cached " + spec.file + " (" + Math.round(bytes.length / 1024) + " kB)");
  return dest;
}

async function localFontCss() {
  try {
    const rules = [];
    for (const spec of FONT_SPECS) {
      const file = await ensureFontTtf(spec);
      rules.push(
        "@font-face{font-family:'" + spec.family + "';font-style:normal;font-weight:" + spec.weight
        + ";src:url('" + pathToFileURL(file).href + "') format('truetype');font-display:block}"
      );
    }
    console.log("fonts: embedding TTF from " + FONT_CACHE);
    return rules.join("\n");
  } catch (err) {
    console.warn("! TTF fetch failed (" + err.message + "), falling back to the page's web fonts");
    return "";
  }
}

async function settle(page) {
  await page.evaluate(async () => {
    const probes = [
      '400 12px "Inter"', '700 24px "Space Grotesk"', '500 16px "Inter"', '400 12px "Noto Sans SC"'
    ];
    for (const p of probes) { try { await document.fonts.load(p); } catch (e) {} }
    await document.fonts.ready;
    const pending = Array.from(document.images).filter((img) => !img.complete);
    await Promise.all(pending.map((img) => new Promise((res) => {
      img.addEventListener("load", res, { once: true });
      img.addEventListener("error", res, { once: true });
      setTimeout(res, 3000);
    })));
  });
  await page.waitForTimeout(350);
}

const fontCss = await localFontCss();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ locale: "en-US", deviceScaleFactor: 1 });
  for (const target of TARGETS) {
    const page = await context.newPage();
    await page.emulateMedia({ media: "print" });
    await page.goto(PAGE_URL, { waitUntil: "load" });
    await page.evaluate((lang) => {
      const h = document.documentElement;
      h.dataset.lang = lang;
      h.setAttribute("lang", lang === "zh" ? "zh-Hans" : "en");
    }, target.lang);
    if (fontCss) await page.addStyleTag({ content: fontCss });
    await settle(page);
    const out = path.join(ROOT, target.file);
    await page.pdf({
      path: out,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false
    });
    console.log("wrote " + target.file + " (" + Math.round(fs.statSync(out).size / 1024) + " kB, lang=" + target.lang + ")");
    await page.close();
  }
} finally {
  await browser.close();
}
