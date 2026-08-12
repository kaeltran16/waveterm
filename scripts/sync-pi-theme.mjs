// Keeps pi/themes/arc.json's palette vars in lockstep with the cockpit's @theme tokens
// (frontend/tailwindsetup.css), the single authored source for the Wave palette. Only the
// "vars" block is derived; the "colors" mapping and "export" section stay authored.
//
// Usage (from the repo root):
//   node scripts/sync-pi-theme.mjs            # check: exit 1 listing any drift
//   node scripts/sync-pi-theme.mjs --write    # regenerate vars values in place
//
// Wired as task sync:pi-theme (write) and into check:pi-theme (check); sync:piartifacts
// depends on sync:pi-theme so the go:embed copy under cmd/wsh/cmd can never go stale.

import { readFileSync, writeFileSync } from "node:fs";

const CSS_PATH = "frontend/tailwindsetup.css";
const writeIdx = process.argv.indexOf("--write");
const WRITE = writeIdx !== -1;
const THEME_PATH = (WRITE ? process.argv[writeIdx + 1] : process.argv[2]) ?? "pi/themes/arc.json";

// arc.json var -> tailwindsetup.css token suffix after --color-.
const VAR_TO_TOKEN = {
    bg: "background",
    surface: "surface",
    surfaceRaised: "surface-raised",
    surfaceHover: "surface-hover",
    surfaceSelected: "surface-selected",
    border: "border",
    edgeMid: "edge-mid",
    edgeStrong: "edge-strong",
    edgeFaint: "edge-faint",
    text: "foreground",
    secondary: "secondary",
    muted: "muted",
    inkFaint: "ink-faint",
    accent: "accent",
    success: "success",
    warning: "warning",
    error: "error",
};

const css = readFileSync(CSS_PATH, "utf8");
const themeBlock = css.match(/@theme \{([\s\S]*?)\n\}/);
if (!themeBlock) {
    throw new Error(`${CSS_PATH}: no @theme block found`);
}
const tokens = new Map();
for (const m of themeBlock[1].matchAll(/--color-([a-z0-9-]+):\s*#([0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(m[1], m[2].toLowerCase());
}

const themeLines = readFileSync(THEME_PATH, "utf8").split("\n");
// Scope every operation to the "vars" block: the "colors" section also contains the same keys
// as values ("accent": "accent"), which would false-match a file-wide search.
const varsStart = themeLines.findIndex((l) => l.includes('"vars": {'));
if (varsStart === -1) {
    throw new Error(`${THEME_PATH}: no "vars" block`);
}
const varsEnd = varsStart + 1 + themeLines.slice(varsStart + 1).findIndex((l) => /^\s*\},?$/.test(l));
const varsBlock = themeLines.slice(varsStart, varsEnd + 1);

const drift = [];
const updates = new Map(); // var -> css value
for (const [vr, token] of Object.entries(VAR_TO_TOKEN)) {
    const want = tokens.get(token);
    if (!want) {
        throw new Error(`${CSS_PATH}: no --color-${token} token in @theme`);
    }
    const line = varsBlock.find((l) => l.includes(`"${vr}": "#`));
    if (!line) {
        throw new Error(`${THEME_PATH}: vars block missing "${vr}"`);
    }
    const cur = line.match(/"#([0-9a-fA-F]{6})"/)[1];
    if (cur.toLowerCase() !== want) {
        drift.push(`  ${vr}: theme "#${cur}" != tokens "#${want}" (--color-${token})`);
        updates.set(vr, want);
    }
}

if (!drift.length) {
    console.log(`ok: ${THEME_PATH} vars match ${CSS_PATH} (${Object.keys(VAR_TO_TOKEN).length} vars)`);
    process.exit(0);
}

if (!WRITE) {
    console.error(`${THEME_PATH} is out of sync with ${CSS_PATH}:\n${drift.join("\n")}\nrun: task sync:pi-theme`);
    process.exit(1);
}

const newVars = varsBlock.map((line) => {
    const m = line.match(/^(\s*"([a-zA-Z]+)":\s*)"#[0-9a-fA-F]{6}"(,?)$/);
    return m && updates.has(m[2]) ? `${m[1]}"#${updates.get(m[2])}"${m[3]}` : line;
});
const out = [
    ...themeLines.slice(0, varsStart),
    ...newVars,
    ...themeLines.slice(varsEnd + 1),
];
writeFileSync(THEME_PATH, out.join("\n"));
console.log(`synced ${THEME_PATH}: ${[...updates.keys()].join(", ")}`);
