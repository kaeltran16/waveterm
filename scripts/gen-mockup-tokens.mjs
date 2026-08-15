#!/usr/bin/env node
// Regenerates the :root token block inside docs/prototype/mockup-template.html from
// frontend/tailwindsetup.css @theme, so mockup colors cannot drift from the app.
// Markers: MOCKUP-TOKENS:START / MOCKUP-TOKENS:END. Run via `task mockup:kit`.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cssPath = resolve(root, "frontend/tailwindsetup.css");
const tplPath = resolve(root, "docs/prototype/mockup-template.html");

const css = readFileSync(cssPath, "utf8");
const theme = css.match(/@theme\s*\{([\s\S]*?)\}/)?.[1];
if (!theme) {
  console.error("no @theme block found in", cssPath);
  process.exit(1);
}
const vars = [];
for (const line of theme.split("\n")) {
  const m = line.match(/^\s*(--color-[\w-]+):\s*([^;]+);/);
  if (m) vars.push([m[1], m[2].trim()]);
}
if (vars.length === 0) {
  console.error("no --color-* vars found in @theme block");
  process.exit(1);
}
const block = ":root {\n" + vars.map(([k, v]) => `    ${k}: ${v};`).join("\n") + "\n}\n";

const tpl = readFileSync(tplPath, "utf8");
const start = "/* MOCKUP-TOKENS:START */";
const end = "/* MOCKUP-TOKENS:END */";
const si = tpl.indexOf(start);
const ei = tpl.indexOf(end, si);
if (si === -1 || ei === -1) {
  console.error("token markers not found in", tplPath);
  process.exit(1);
}
writeFileSync(tplPath, tpl.slice(0, si + start.length) + "\n" + block + tpl.slice(ei));
console.log(`wrote ${vars.length} color tokens into mockup-template.html`);
