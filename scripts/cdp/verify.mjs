// One-command verification runner. Attaches to the running dev app over CDP, runs each scenario
// (arrange -> goto -> shot -> assert -> teardown), prints a PASS/FAIL table, writes a contact sheet,
// and exits nonzero on any failure. Usage: node scripts/cdp/verify.mjs [name...]
import { mkdirSync, writeFileSync } from "node:fs";
import { attach } from "./attach.mjs";
import { contactSheetHtml, exitCode, formatResults } from "./report.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const chosen = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
if (!chosen.length) {
    console.error(`no scenarios matched ${JSON.stringify(only)}. available: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(2);
}

const h = await attach();
console.log(`attached to ${h.url}`);

const results = [];
for (const scenario of chosen) {
    let ctx;
    try {
        ctx = await scenario.arrange(h);
        await h.goto(scenario.surface);
        await h.shot(`cdp-shots/${scenario.name}.png`);
        const steps = await scenario.assert(h, ctx);
        results.push({ name: scenario.name, steps });
    } catch (e) {
        results.push({ name: scenario.name, steps: [], error: String(e?.message ?? e) });
    } finally {
        try {
            if (ctx !== undefined) await scenario.teardown?.(h, ctx);
        } catch (e) {
            console.error(`teardown failed for ${scenario.name}: ${e?.message ?? e}`);
        }
    }
}
h.close();

console.log(formatResults(results));
mkdirSync("cdp-shots", { recursive: true });
writeFileSync("cdp-shots/index.html", contactSheetHtml(h.shots));
console.log(`\ncontact sheet: cdp-shots/index.html`);
process.exit(exitCode(results));
