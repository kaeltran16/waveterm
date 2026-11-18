// Scenario `workspace-ring`: the session popover on the Rendered composer's context ring (Task 4 of
// docs/superpowers/plans/2026-11-17-workspace-pane.md; the Main board's ring). Three fixture claude agents on real
// tabs: W reports a warn-level context and its block runs the key probe (fixtures/keyprobe.mjs), so Compact and Clear
// are read back from what reached its pty; O reports an ok-level context; N reports none. Their transcripts hold
// usage records from two hours ago, so the cache reads "expired" and the Session line holds still while the steps
// compare the popover with the Terminal view's rail. Teardown puts back the views and the rail, the roster and the
// default view, closes the tabs and removes the temp dir.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreDefaultView,
    restoreRoster,
    setRoster,
    usage,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishNap, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "workspace-ring";
const KEYPROBE = fileURLToPath(new URL("./fixtures/keyprobe.mjs", import.meta.url));
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
const PROBE_BOOT_MS = 20_000;
const PROBE_SETTLE_MS = 1_000;
const PROBE_WAIT_MS = 5_000;
// longer than PopoverReveal's exit
const SETTLE_MS = 600;
const HOUR_MS = 3_600_000;
const POPOVER_PX = 320;
const FIT_PX = 1;
// the tooltip host parks a title in data-arc-title while the pointer rests on its element
const RING_TITLE = "Session, context and token usage";
// W's 62% of a 200k window is warn by fullness (124k is under the token warning); O's 6% of 1M is ok
const WARN_USAGE = { contextpct: 62, contextmax: 200_000 };
const OK_USAGE = { contextpct: 6, contextmax: 1_000_000 };
const WARN_NOTE = "124k of 200k tokens";
const ESC = "1b";

const HEADER = `document.querySelector("[data-agent-header]")`;
const RING = `document.querySelector("[data-rendered-composer] [data-context-ring]")`;
const POP = `document.querySelector('[role="dialog"][aria-label="Session"]')`;
const RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;

const rosterAgent = (id, blockId, name, transcriptPath, agentUsage) => ({
    id,
    name,
    project: "fx-ring",
    task: "workspace ring fixture",
    state: "idle",
    idleSince: Date.now() - 2 * HOUR_MS,
    agent: "claude",
    model: "claude-opus-5-5",
    blockId,
    transcriptPath,
    ...(agentUsage ? { usage: agentUsage } : {}),
});

const probeLines = (ctx) => (existsSync(ctx.probe) ? readFileSync(ctx.probe, "utf8").split("\n").filter(Boolean) : []);
const probeText = (ctx, from) => Buffer.from(probeLines(ctx).slice(from).join(""), "hex").toString("utf8");

async function waitTyped(ctx, from, want) {
    const end = Date.now() + PROBE_WAIT_MS;
    while (!probeText(ctx, from).includes(want) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
    }
    return probeText(ctx, from);
}

// what the ring and the popover say: the facts the steps compare
const ringFacts = (h) =>
    agentPage(
        h,
        `const ring = ${RING};
        const pop = ${POP};
        const box = document.querySelector("[data-rendered-composer] [data-composer-box]");
        const session = pop?.querySelector("[data-rail-state]")?.parentElement;
        const ctxRow = pop?.querySelector("[data-session-context]");
        const p = pop?.parentElement?.getBoundingClientRect();
        const b = box?.getBoundingClientRect();
        return {
            ring: ring ? { tag: ring.tagName, text: flat(ring), title: ring.title || ring.getAttribute("data-arc-title"), expanded: ring.getAttribute("aria-expanded") } : null,
            pop: pop
                ? {
                      session: flat(session),
                      context: ctxRow ? flat(ctxRow) : null,
                      resets: [...pop.querySelectorAll("[data-context-reset]")].map((x) => x.dataset.contextReset),
                      tokens: flat(pop.querySelector("[data-token-usage]")),
                      width: Math.round(p.width),
                      rightGap: Math.round(b.right - p.right),
                      above: p.bottom <= b.top,
                  }
                : null,
            focus: document.activeElement?.matches?.("[data-rendered-composer] textarea") ?? false,
        };`
    );

// a real click at an element's center, so the pointerdown the popover listens for reaches it as the user's would
async function clickAt(h, selector) {
    const at = await h.ev(`(() => { const r = ${selector}?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    if (at == null) throw new Error(`nothing to click at ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    }
}

async function pressEscape(h) {
    for (const type of ["keyDown", "keyUp"]) {
        await h.cdp("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    }
}

async function focusRendered(h, id, name) {
    await focusAgent(h, id);
    const ok = await polishWaitFor(
        h,
        `(${HEADER}?.textContent ?? "").includes(${JSON.stringify(name)}) && ${RING} != null`,
        WAIT_MS
    );
    if (!ok) throw new Error(`${name} never showed the Rendered composer's ring`);
}

async function openPopover(h) {
    await clickAt(h, RING);
    // the token figures load from the transcript once the popover mounts
    return polishWaitFor(h, `${POP}?.querySelector("[data-token-usage]") != null`, WAIT_MS);
}

const setView = (h, id, mode) =>
    agentPage(
        h,
        `const R = await mod("app/view/agents/renderedmode.ts");
        globalStore.set(R.viewModeAtom(${JSON.stringify(id)}), ${JSON.stringify(mode)});
        return true;`
    );

export const workspaceRing = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-ring-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            ctx.probe = join(ctx.dir, "keyprobe.log");
            const ts = new Date(Date.now() - 2 * HOUR_MS).toISOString();
            const transcript = (n) =>
                writeTranscript(ctx.dir, `ring-${n}-${tag}`, [
                    userText(`Tidy the ${n} notes.`, { ts }),
                    usage({ input: 1200, output: 800, cacheRead: 40_000, cacheWrite: 9_000, ts }),
                    assistantText(`The ${n} notes are tidy.`, { ts }),
                ]);
            await h.goto("agent");
            await pinDefaultView(h, "rendered");
            // the cwd is ~, not the temp dir, which the probe would keep locked past teardown
            const w = await makeTab(h, ctx, {
                label: `ring-w-${tag}`,
                blockMeta: {
                    view: "term",
                    controller: "cmd",
                    cmd: `node '${KEYPROBE}' '${ctx.probe}'`,
                    "cmd:cwd": "~",
                    "cmd:keeponexit": true,
                },
            });
            const o = await makeTab(h, ctx, { label: `ring-o-${tag}`, blockMeta: { view: "term", controller: null } });
            const n = await makeTab(h, ctx, { label: `ring-n-${tag}`, blockMeta: { view: "term", controller: null } });
            // the meta change can start a probe that ends at once; the file the restarted one writes is the proof a
            // live probe is reading
            await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));
            rmSync(ctx.probe, { force: true });
            await h.rpc("controllerresync", { tabid: w.tabId, blockid: w.blockId, forcerestart: true });
            for (const end = Date.now() + PROBE_BOOT_MS; !existsSync(ctx.probe) && Date.now() < end; ) {
                await new Promise((r) => setTimeout(r, 200));
            }
            if (!existsSync(ctx.probe)) throw new Error(`the key probe never started (no ${ctx.probe})`);
            Object.assign(ctx, {
                wId: w.tabId,
                wName: `ring-w-${tag}`,
                oId: o.tabId,
                oName: `ring-o-${tag}`,
                nId: n.tabId,
                nName: `ring-n-${tag}`,
            });
            await setRoster(h, [
                rosterAgent(w.tabId, w.blockId, ctx.wName, transcript("w"), WARN_USAGE),
                rosterAgent(o.tabId, o.blockId, ctx.oName, transcript("o"), OK_USAGE),
                rosterAgent(n.tabId, n.blockId, ctx.nName, transcript("n"), null),
            ]);
            await focusRendered(h, ctx.wId, ctx.wName);
        } catch (err) {
            ctx.arrangeError = String(err?.message ?? err);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        // one throwing step is one FAIL, not the end of the run
        const step = async (name, fn) => {
            try {
                const [ok, detail] = await fn();
                rec(name, ok, detail);
            } catch (err) {
                rec(name, false, `threw: ${err?.message ?? err}`);
            }
        };
        await focusRendered(h, ctx.wId, ctx.wName);

        await step("the ring is a closed button with the session title and the warn-level percent", async () => {
            const f = await ringFacts(h);
            const ok =
                f.ring?.tag === "BUTTON" &&
                f.ring.text === `${WARN_USAGE.contextpct}%` &&
                f.ring.title === RING_TITLE &&
                f.ring.expanded === "false" &&
                f.pop == null;
            return [ok, f];
        });

        await step("clicking the ring reveals the popover, scaling in from transparent (PopoverReveal)", async () => {
            const at = await h.ev(`(() => { const r = ${RING}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            // sample the reveal's opacity every frame from the click on
            await h.ev(`(() => {
                window.__ringReveal = [];
                const tick = () => {
                    const el = document.querySelector('[role="dialog"][aria-label="Session"]')?.parentElement;
                    if (el) window.__ringReveal.push(+getComputedStyle(el).opacity);
                    if (window.__ringReveal.length < 40) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
                return true;
            })()`);
            for (const type of ["mousePressed", "mouseReleased"]) {
                await h.cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
            }
            await polishNap(SETTLE_MS);
            const seen = await h.ev(`window.__ringReveal`);
            await h.shot(`cdp-shots/${NAME}-open.png`);
            const ok = seen.length > 1 && seen[0] < 1 && seen.at(-1) === 1;
            return [ok, { first: seen[0], last: seen.at(-1), frames: seen.length }];
        });

        await step("the popover sits 320px wide above the composer, right-aligned, with Session, Context, the resets and Token usage", async () => {
            await polishWaitFor(h, `${POP}?.querySelector("[data-token-usage]") != null`, WAIT_MS);
            const f = await ringFacts(h);
            const p = f.pop;
            const ok =
                f.ring?.expanded === "true" &&
                p != null &&
                p.width === POPOVER_PX &&
                Math.abs(p.rightGap) <= FIT_PX &&
                p.above &&
                p.session.startsWith("idle") &&
                p.session.includes("cache expired") &&
                p.context?.includes(`${WARN_USAGE.contextpct}%`) &&
                p.context.includes(WARN_NOTE) &&
                JSON.stringify(p.resets) === JSON.stringify(["compact", "clear"]) &&
                p.tokens.length > 0;
            return [ok, f];
        });

        await step("Compact and Clear each type their command into the agent, as the rail's do", async () => {
            const from = probeLines(ctx).length;
            await clickAt(h, `${POP}?.querySelector('[data-context-reset="compact"]')`);
            const compact = await waitTyped(ctx, from, "/compact\r");
            const mid = probeLines(ctx).length;
            await clickAt(h, `${POP}?.querySelector('[data-context-reset="clear"]')`);
            const clear = await waitTyped(ctx, mid, "/clear\r");
            const ok = compact.includes("/compact\r") && clear.includes("/clear\r") && !compact.includes("/clear");
            return [ok, { compact, clear }];
        });

        await step("Esc closes the popover, hands focus to the composer and sends the agent no interrupt", async () => {
            await polishWaitFor(h, `${POP} != null`, WAIT_MS);
            const from = probeLines(ctx).length;
            await pressEscape(h);
            const closed = await polishWaitFor(h, `${POP} == null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await ringFacts(h);
            const esc = probeLines(ctx).slice(from).some((l) => l.includes(ESC));
            const surface = await agentPage(h, `return globalStore.get(agentsModel().surfaceAtom);`);
            return [closed && f.ring?.expanded === "false" && f.focus && !esc && surface === "agent", { ...f, esc, surface }];
        });

        await step("the ring again closes it and hands focus to the composer", async () => {
            const opened = await openPopover(h);
            await clickAt(h, RING);
            const closed = await polishWaitFor(h, `${POP} == null`, WAIT_MS);
            const f = await ringFacts(h);
            return [opened && closed && f.focus, { opened, closed, ...f }];
        });

        await step("a click outside closes it", async () => {
            const opened = await openPopover(h);
            await clickAt(h, `document.querySelector("[data-rendered-view]")`);
            const closed = await polishWaitFor(h, `${POP} == null`, WAIT_MS);
            return [opened && closed, { opened, closed }];
        });

        await step("the popover's Session, Context and token figures equal the Terminal view's rail for the same agent", async () => {
            await openPopover(h);
            await polishNap(SETTLE_MS);
            const pop = (await ringFacts(h)).pop;
            await pressEscape(h);
            await setView(h, ctx.wId, "terminal");
            await agentPage(
                h,
                `const { railVisibleAtom } = await mod("app/view/agents/railstore.ts");
                if (!("__railVisiblePrev" in window)) window.__railVisiblePrev = globalStore.get(railVisibleAtom);
                globalStore.set(railVisibleAtom, true);
                return true;`
            );
            ctx.railTouched = true;
            await polishWaitFor(h, `${RAIL}?.querySelector("[data-token-usage]") != null && ${RAIL}?.querySelector("[data-session-context]") != null`, WAIT_MS);
            const rail = await agentPage(
                h,
                `const r = ${RAIL};
                return {
                    session: flat(r?.querySelector("[data-rail-state]")?.parentElement),
                    context: flat(r?.querySelector("[data-session-context]")),
                    tokens: flat(r?.querySelector("[data-token-usage]")),
                };`
            );
            await h.shot(`cdp-shots/${NAME}-rail.png`);
            await setView(h, ctx.wId, "rendered");
            const ok =
                pop != null &&
                rail.session === pop.session &&
                rail.context === pop.context &&
                rail.tokens === pop.tokens &&
                rail.tokens.length > 0;
            return [ok, { pop, rail }];
        });

        await step("an ok-level agent's popover has its Context row and no Compact or Clear", async () => {
            await focusRendered(h, ctx.oId, ctx.oName);
            const opened = await openPopover(h);
            const f = await ringFacts(h);
            await h.shot(`cdp-shots/${NAME}-ok.png`);
            await pressEscape(h);
            await polishWaitFor(h, `${POP} == null`, WAIT_MS);
            const ok =
                opened &&
                f.ring?.text === `${OK_USAGE.contextpct}%` &&
                f.pop?.context?.includes(`${OK_USAGE.contextpct}%`) &&
                f.pop.resets.length === 0;
            return [ok, f];
        });

        await step("with no context reading the ring draws empty without a percent, and the popover has no Context row", async () => {
            await focusRendered(h, ctx.nId, ctx.nName);
            const opened = await openPopover(h);
            const f = await ringFacts(h);
            await h.shot(`cdp-shots/${NAME}-no-reading.png`);
            await pressEscape(h);
            await polishWaitFor(h, `${POP} == null`, WAIT_MS);
            const ok =
                opened &&
                f.ring?.tag === "BUTTON" &&
                f.ring.text === "" &&
                f.ring.title === RING_TITLE &&
                f.pop?.context == null &&
                f.pop.session.startsWith("idle") &&
                f.pop.tokens.length > 0;
            return [ok, f];
        });
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        if (ctx.railTouched) {
            await step("put back the rail", () =>
                agentPage(
                    h,
                    `const { railVisibleAtom } = await mod("app/view/agents/railstore.ts");
                    if ("__railVisiblePrev" in window) {
                        globalStore.set(railVisibleAtom, window.__railVisiblePrev);
                        delete window.__railVisiblePrev;
                    }
                    return true;`
                )
            );
        }
        if (ctx.wId) await step("put back W's view", () => setView(h, ctx.wId, "rendered"));
        await step("restore the roster", () => restoreRoster(h));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("restore the default view", () => restoreDefaultView(h));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true }));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("go home", () => h.goto("cockpit"));
    },
};
