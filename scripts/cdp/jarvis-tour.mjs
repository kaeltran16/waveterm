// Regenerates the screenshots in docs/jarvis-tour.md by driving the live dev app over CDP.
//
//   node scripts/cdp/jarvis-tour.mjs [outdir] [port]
//   # default: docs/images/jarvis-tour on :9222
//
// PREREQUISITE: `task dev` running with the debug port (dev-only, src-tauri/src/main.rs). This is a
// documentation driver, not a verification scenario — it asserts only enough to fail loudly when a state
// it meant to photograph is not on screen. For pass/fail regression nets see scripts/cdp/scenarios.mjs.
//
// SAFETY — this script must never dispatch work. It does not press Enter on a channel Launch composer,
// does not pick a channel in the off-channel dispatch picker, and does not press Save in the profile
// drawer; each of those spawns a real worker or writes real config. The one setting it changes (the
// autonomy tier, for the Delegator shot) is read first and restored afterwards.
//
// ORDERING CONSTRAINT: the two "nothing to focus" peek shots must be taken after a page reload, before
// any peek has focused anything. graphSelectedIdAtom is a module atom and the focusing effect returns
// early when there is nothing to focus, so it never clears an earlier selection — a peek opened from a
// thread otherwise inherits the node the previous peek selected.
//
// Expects the dev vault to hold a channel named `waveterm` with runs carrying attribution edges, plus at
// least one Radar finding. Every step that cannot find its subject logs FAIL and the run continues, so a
// thin vault yields a partial set rather than an abort.

import { attach } from "./attach.mjs";

const OUT = process.argv[2] ?? "docs/images/jarvis-tour";
const PORT = process.argv[3] ?? "9222";

const CHANNEL = "waveterm";
const RECORD = "how can both items are selected at once";
const SEVERAL_RUN = "Diff commit 38f0c9d"; // a run with two attribution edges
const ONE_RUN = "how can both items are selected"; // a run with one
const FILTER_NODE = "validate";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let h;
try {
    h = await attach(PORT);
} catch (e) {
    console.error(`jarvis-tour: ${e?.message ?? e}`);
    process.exit(1);
}

// --- driving helpers ------------------------------------------------------------------------------
// Click the first element matching `css` whose text contains (or equals, when exact) `text`.
async function click(css, text, { exact = false } = {}) {
    const ok = await h.ev(`(() => {
        const want = ${JSON.stringify(text)};
        const el = [...document.querySelectorAll(${JSON.stringify(css)})].find((e) => {
            const t = (e.innerText || e.textContent || '').trim();
            return ${exact ? "t === want" : "t.includes(want)"};
        });
        if (!el) return false;
        el.click();
        return true;
    })()`);
    if (!ok) throw new Error(`click: no ${css} matching ${JSON.stringify(text)}`);
    await sleep(500);
}

async function tryClick(css, text, opts) {
    try {
        await click(css, text, opts);
        return true;
    } catch {
        return false;
    }
}

// A subject row and a run row can carry the same text (a run's goal becomes its record's objective), so
// text alone picks the wrong one. Subject rows lead with their kind mark; run rows lead with a status dot.
async function clickSubject(label, mark) {
    const ok = await h.ev(`(() => {
        const want = ${JSON.stringify(label)}, mark = ${JSON.stringify(mark ?? null)};
        const el = [...document.querySelectorAll('button')].find((b) => {
            const r = b.getBoundingClientRect();
            if (r.x > 290 || r.width < 40) return false;
            if (!(b.innerText || '').trim().includes(want)) return false;
            const lead = (b.firstElementChild?.textContent || '').trim();
            return mark == null ? true : lead === mark;
        });
        if (!el) return false;
        el.click();
        return true;
    })()`);
    if (!ok) throw new Error(`clickSubject: no ${mark ?? "row"} matching ${JSON.stringify(label)}`);
    await sleep(800);
}

async function clickRun(goalFragment) {
    const ok = await h.ev(`(() => {
        const want = ${JSON.stringify(goalFragment)};
        const el = [...document.querySelectorAll('button')].find((b) => {
            const r = b.getBoundingClientRect();
            if (r.x > 290 || r.width < 40) return false;
            if ((b.firstElementChild?.textContent || '').trim() !== '') return false;
            return (b.innerText || '').trim().includes(want);
        });
        if (!el) return false;
        el.click();
        return true;
    })()`);
    if (!ok) throw new Error(`clickRun: no run row matching ${JSON.stringify(goalFragment)}`);
    await sleep(800);
}

// a plain text button (the + Channel project list) rather than a subject row, which wraps its label
async function clickPlainButton(text) {
    const ok = await h.ev(`(() => {
        const want = ${JSON.stringify(text)};
        const el = [...document.querySelectorAll('button')].find(
            (b) => b.children.length === 0 && b.getBoundingClientRect().x < 290 && (b.textContent || '').trim() === want
        );
        if (!el) return false;
        el.click();
        return true;
    })()`);
    if (!ok) throw new Error(`clickPlainButton: none matching ${JSON.stringify(text)}`);
    await sleep(500);
}

// React does not observe a raw .value assignment; go through the prototype setter + an input event.
async function type(placeholder, value) {
    const ok = await h.ev(`(() => {
        const el = [...document.querySelectorAll('input,textarea')]
            .find((e) => (e.placeholder || '').includes(${JSON.stringify(placeholder)}));
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        return true;
    })()`);
    if (!ok) throw new Error(`type: no field with placeholder ${JSON.stringify(placeholder)}`);
    await sleep(350);
}

async function key(k, { code, keyCode, modifiers = 0 } = {}) {
    const base = { key: k, code: code ?? k, windowsVirtualKeyCode: keyCode, modifiers };
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(450);
}

const esc = () => key("Escape", { code: "Escape", keyCode: 27 });
const body = () => h.ev(`(document.body.innerText || '').trim()`);

async function reload() {
    await h.cdp("Page.reload", {});
    await sleep(4000);
}

// Emulation rather than resizing the user's window: it only changes how the page renders, and therefore
// what captureScreenshot returns. Cleared at the end so the dev window is left as it was found.
async function setViewport(width, height) {
    await h.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
}

let n = 0;
const results = [];
async function step(name, fn) {
    n += 1;
    const id = String(n).padStart(2, "0");
    try {
        const note = (await fn()) ?? "";
        await h.shot(`${OUT}/${id}-${name}.png`);
        results.push({ ok: true, shot: `${id}-${name}.png`, note });
        console.log(`ok   ${id}-${name}  ${note}`);
    } catch (e) {
        results.push({ ok: false, shot: `${id}-${name}.png`, note: String(e?.message ?? e) });
        console.log(`FAIL ${id}-${name}: ${e?.message ?? e}`);
    }
}

// --- the tour ------------------------------------------------------------------------------------
await setViewport(1440, 900);
await reload();
await h.goto("jarvis");

await step("empty-stage", async () => {
    if (!/Point me at some work/i.test((await body()) ?? "")) throw new Error("not the empty Stage");
    return "fresh launch, no subject";
});

await step("new-channel-picker", async () => {
    await click("button", "+ Channel");
    return "project list";
});
await step("new-channel-name", async () => {
    await clickPlainButton(CHANNEL);
    if (!/Create/.test((await body()) ?? "")) throw new Error("no name step");
    return "name step, prefilled";
});
await tryClick("button", "Back");
await tryClick("button", "+ Channel"); // toggle the picker back off

await step("channel-launch", async () => {
    await clickSubject(CHANNEL, "#");
    if (!/pipeline run|orchestrator/.test((await body()) ?? "")) throw new Error("no strategy footer");
    return "Launch face + run switcher";
});
await step("launch-draft", async () => {
    await type("Give Jarvis a goal", "tighten the record band copy");
    return "goal typed, NOT submitted";
});
await type("Give Jarvis a goal", "");

await step("record-band-several", async () => {
    await clickRun(SEVERAL_RUN);
    const edges = ((await body()) ?? "").match(/confirmed · strong|informing · weak/g);
    if (!edges || edges.length < 2) throw new Error("run has fewer than two edges");
    return "edges: " + edges.join(", ");
});
await step("record-band-expanded", async () => {
    await click("span", "Expand");
    if (!/MACHINE-MAINTAINED/i.test((await body()) ?? "")) throw new Error("record detail did not open");
    return "TaskDetail + extra edge as a row";
});
await tryClick("span", "Collapse");
await step("record-band-one", async () => {
    await clickRun(ONE_RUN);
    if (!/Expand the record/.test((await body()) ?? "")) throw new Error("not the single-edge case");
    return "one edge";
});

// the autonomy tier is the only setting this script changes — read it, then put it back
const tierOf = async () => {
    const res = await h.rpc("getchannels", null);
    const c = (res.channels || []).find((x) => x.name === CHANNEL);
    return c?.meta?.["delegator:enabled"] ? "Delegator" : c?.meta?.["gatekeeper:enabled"] ? "Gatekeeper" : "Concierge";
};
const tierBefore = await tierOf();
await step("autonomy-delegator", async () => {
    await click("button", "Delegator", { exact: true });
    if (!/report|manage|fanout/.test((await body()) ?? "")) throw new Error("no dispatch modes at Delegator");
    return `dispatch modes shown (tier was ${tierBefore})`;
});
await tryClick("button", tierBefore, { exact: true });
const tierAfter = await tierOf();
console.log(`     autonomy tier: ${tierBefore} -> ${tierAfter}${tierAfter === tierBefore ? "" : "  *** NOT RESTORED ***"}`);

await step("profile-drawer", async () => {
    await click("button", "⚙", { exact: true });
    if (!/Playbook/i.test((await body()) ?? "")) throw new Error("drawer did not open");
    return "scope toggle + playbook + run defaults";
});
await step("profile-principles", async () => {
    await h.ev(`(() => {
        const el = [...document.querySelectorAll('*')].find((e) => /^Principles/i.test((e.innerText || '').trim()));
        if (el) el.scrollIntoView({ block: 'center' });
        return true;
    })()`);
    return "per-principle override / disable";
});
await esc();

await step("palette-launch", async () => {
    await key("p", { code: "KeyP", keyCode: 80, modifiers: 2 });
    if (!(await h.ev(`!!document.querySelector('[class*="z-[70]"]')`))) throw new Error("palette did not open");
    await type("Search, or type", "add a delete control to the record band");
    if (!/one worker · no phases/.test((await body()) ?? "")) throw new Error("no launch rows");
    return "Quick / Run / Ask x2 / Ask Jarvis";
});
await esc();

await step("record-subject", async () => {
    await clickSubject(RECORD, "▤");
    if (!/Selected directly from Records/.test((await body()) ?? "")) throw new Error("not a record subject");
    return "record fields + activity + decisions";
});
await step("record-decision-form", async () => {
    await click("button", "+ Add decision");
    // placeholders are not in innerText, so assert on the field itself
    const has = await h.ev(
        `!![...document.querySelectorAll('textarea')].find((t) => /Rationale/i.test(t.placeholder || ''))`
    );
    if (!has) throw new Error("append form did not open");
    return "summary + rationale (not submitted)";
});
await tryClick("button", "Cancel");

await step("graph-peek-record", async () => {
    await click("button", "Graph", { exact: true });
    await sleep(2500); // force layout + the lazy react-force-graph chunk
    if (!/SELECTED NODE/i.test((await body()) ?? "")) throw new Error("peek did not focus the record");
    return "focused, with edges + actions";
});
await esc();

await step("thread-empty", async () => {
    await click("button", "+ Thread");
    if (!/Ask Jarvis/i.test((await body()) ?? "")) throw new Error("no empty thread state");
    return "unasked thread";
});
await step("offchannel-channel-picker", async () => {
    await type("Ask Jarvis anything", "@run tighten the record band copy");
    await key("Enter", { code: "Enter", keyCode: 13 });
    if (!/DISPATCH INTO WHICH CHANNEL/i.test((await body()) ?? "")) throw new Error("no channel picker");
    return "picker shown, nothing dispatched";
});
await tryClick("button", "Cancel");

// the reload is load-bearing: see the ordering constraint in the header
await reload();
await h.goto("jarvis");
await step("graph-peek-filter", async () => {
    await click("button", "+ Thread");
    await click("button", "Graph", { exact: true });
    await sleep(3000);
    const t = (await body()) ?? "";
    if (/SELECTED NODE/i.test(t)) throw new Error("a node is selected — stale selection, reload first");
    if (!/Click a node/i.test(t)) throw new Error("no nothing-to-focus copy");
    return "nothing to focus, filter offered";
});
await step("graph-peek-search", async () => {
    await type("Find a node", FILTER_NODE);
    return `filtered to '${FILTER_NODE}'`;
});
await esc();

for (const fx of ["grounded", "working", "weak", "notfound", "stale", "contextual"]) {
    await step("fixture-" + fx, async () => {
        await click("button", fx, { exact: true });
        return fx;
    });
}
await step("fixture-narrow", async () => {
    await click("button", "narrow", { exact: true });
    return "rail collapsed to its strip";
});
// stageRailOpenAtom is persisted to localStorage, so leave the rail open again
await tryClick("button", "grounded", { exact: true });

await h.goto("radar");
// the actions live on the finding DETAIL panel, so a finding has to be selected first
const pickFinding = () =>
    h.ev(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^(HIGH|MEDIUM|LOW)\\n/.test((x.innerText || '').trim()));
        if (!b) return false;
        b.click();
        return true;
    })()`);
await step("radar-finding-actions", async () => {
    if (!(await pickFinding())) throw new Error("no Radar findings to select");
    await sleep(1000);
    if (!/Explain with Jarvis/.test((await body()) ?? "")) throw new Error("no finding actions");
    return "Start investigation + Explain with Jarvis";
});
await step("contextual-thread", async () => {
    await click("button", "Explain with Jarvis", { exact: true });
    const draft = await h.ev(
        `(() => { const i = [...document.querySelectorAll('input')].find((e) => /Ask Jarvis/.test(e.placeholder || '')); return i ? i.value : null; })()`
    );
    if (!/This finding/.test((await body()) ?? "")) throw new Error("no This finding chip");
    return `chip + prefilled ${JSON.stringify(draft)}`;
});

await h.goto("radar");
await step("radar-run-draft", async () => {
    if (!(await pickFinding())) throw new Error("no Radar findings to select");
    await sleep(1000);
    await click("button", "Start investigation", { exact: true });
    await sleep(1200);
    // "From Radar" is CSS-uppercased, so innerText reads FROM RADAR — match case-insensitively
    if (!/FROM RADAR/i.test((await body()) ?? "")) throw new Error("no From Radar banner");
    return "goal held for review, not dispatched";
});
await tryClick("button", "Discard"); // never press Start

await h.goto("jarvis");
await step("subject-filter", async () => {
    await type("Filter subjects", "diff");
    return "filtered to 'diff'";
});
await type("Filter subjects", "");

console.log("\n--- summary ---");
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.shot}  ${r.note}`);
const okCount = results.filter((r) => r.ok).length;
console.log(`\n${okCount}/${results.length} shots -> ${OUT}`);

await reload(); // clears the fixture selection (activeFixtureAtom is not persisted)
try {
    await h.cdp("Emulation.clearDeviceMetricsOverride", {});
} catch {
    /* leaving the override set is not worth failing the run over */
}
h.close();
process.exit(okCount === results.length ? 0 : 1);
