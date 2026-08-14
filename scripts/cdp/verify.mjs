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

const cdpPort = Number(process.env.CDP_PORT) || 9222; // worktree dev app can run on another port (see task worktree:prepare)
const h = await attach(cdpPort);
console.log(`attached to ${h.url}`);

// Pin the viewport so a scenario's result does not depend on how wide the developer left the dev window.
// The Jarvis surface is width-responsive (jarvislayout.ts): below ~1290px its context rail closes and
// below ~1034px the Subjects column drops to status dots, so a run in a 1000px window was asserting
// against a different layout than a run in a 1920px one. Scenarios that drive width themselves override
// this and restore it in teardown.
const VERIFY_VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
await h.cdp("Emulation.setDeviceMetricsOverride", VERIFY_VIEWPORT);

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
        // a scenario that drove width leaves the override where it put it; restore the pin for the next one
        await h.cdp("Emulation.setDeviceMetricsOverride", VERIFY_VIEWPORT).catch(() => {});
    }
}
await h.cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
h.close();

console.log(formatResults(results));
mkdirSync("cdp-shots", { recursive: true });
writeFileSync("cdp-shots/index.html", contactSheetHtml(h.shots));
console.log(`\ncontact sheet: cdp-shots/index.html`);
process.exit(exitCode(results));
