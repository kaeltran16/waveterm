// Validates pi/themes/arc.json against the published pi theme schema's required token list.
// The required list is vendored here (51 tokens) so the check runs offline; the schema lives at
// https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json
import { readFileSync } from "node:fs";

const required = [
    "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
    "muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg", "userMessageText",
    "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
    "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink",
    "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
    "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
    "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
    "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
    "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];

const file = process.argv[2] ?? "pi/themes/arc.json";
const theme = JSON.parse(readFileSync(file, "utf8"));
if (!theme.name) throw new Error(`${file}: missing "name"`);
const missing = required.filter((k) => !(k in theme.colors));
if (missing.length) throw new Error(`${file}: missing required colors: ${missing.join(", ")}`);
const colorValue = (v) => typeof v === "number" || (typeof v === "string" && /^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|[A-Za-z][\w-]*|)$/.test(v));
const bad = Object.entries(theme.colors).filter(([, v]) => !colorValue(v)).map(([k]) => k);
if (bad.length) throw new Error(`${file}: invalid color values for: ${bad.join(", ")}`);
console.log(`ok: ${file} (${Object.keys(theme.colors).length} colors, all ${required.length} required present)`);
