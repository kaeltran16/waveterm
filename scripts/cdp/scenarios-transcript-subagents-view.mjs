// Scenario `transcript-subagents-view`: a subagent opened in the center as a full-size, read-only transcript under
// its banner. Arranged over the transcript-subagents fixture (transcript-subagents-fixture.mjs) with the parent
// working; teardown removes it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPage } from "./agent-page-fixtures.mjs";
import { OBS_WIDE, polishNap, polishWaitFor } from "./scenarios-shared.mjs";
import {
    arrangeSubagentsAgent,
    finishSubagent,
    PARENT_NAME,
    SUBAGENTS,
    teardownSubagentsAgent,
    writeSubagentsFixture,
} from "./transcript-subagents-fixture.mjs";

const NAME = "transcript-subagents-view";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
// the first listing reads every child file; a finish lands on the next 2 s poll
const LIST_WAIT_MS = 20_000;
const VIEW_WAIT_MS = 10_000;
const SCROLL_SETTLE_MS = 400;
const SCROLL_SLACK_PX = 2;
// short enough that the parent's transcript scrolls
const SHORT_VIEW = { ...OBS_WIDE, height: 520 };
// a full-size step row's inline padding (px-3.5); the compact variant's is 10px
const FULL_STEP_PAD = "14px";

const SURFACE = `document.querySelector("[data-cockpit-surface-wrap]")`;
const VIEW = `${SURFACE}?.querySelector("[data-subagent-view]")`;
const SCROLLER = `${SURFACE}?.querySelector("[data-rendered-scroll]")`;
const flat = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;
const visible = (expr) => `((${expr})?.checkVisibility({ visibilityProperty: true }) === true)`;

// what the view shows: its banner, now line, step rows' padding, and whether any message box is on screen
const viewProbe = `(() => {
    const v = ${VIEW};
    if (!v) return null;
    const banner = v.querySelector("[data-subagent-banner]");
    const steps = [...v.querySelectorAll("[data-step]:not([data-step-group])")];
    const boxes = [...(${SURFACE}?.querySelectorAll("textarea") ?? [])].filter((t) =>
        t.checkVisibility({ visibilityProperty: true })
    );
    return {
        banner: ${flat(`banner`)},
        state: banner?.querySelector("[data-subagent-state]")?.getAttribute("data-subagent-state") ?? null,
        back: banner?.querySelector("[data-subagent-back]") != null,
        now: ${flat(`v.querySelector("[data-subagent-now]")`)},
        nowTitle: ${flat(`v.querySelector("[data-subagent-now-title]")`)},
        steps: steps.length,
        pads: [...new Set(steps.map((s) => getComputedStyle(s).paddingLeft))],
        boxes: boxes.length,
    };
})()`;

// opens the child through the store, once the parent's list holds it with its facts
async function openChild(h, ctx, agentId) {
    const body = `const S = await mod("app/view/agents/subagentsstore.ts");
        const sub = (globalStore.get(S.subagentsByIdAtom)[${JSON.stringify(ctx.parentId)}] ?? []).find(
            (s) => s.id === ${JSON.stringify(agentId)} && s.toolCount != null
        );
        if (!sub) return false;
        S.openSubagent(${JSON.stringify(ctx.parentId)}, sub);
        return true;`;
    for (let waited = 0; waited < LIST_WAIT_MS; waited += 250) {
        if (await agentPage(h, body).catch(() => false)) {
            return polishWaitFor(h, `${VIEW}?.getAttribute("data-subagent-view") === ${JSON.stringify(agentId)}`, VIEW_WAIT_MS);
        }
        await polishNap(250);
    }
    return false;
}

const setViewMode = (h, ctx, mode) =>
    agentPage(
        h,
        `const R = await mod("app/view/agents/renderedmode.ts");
        globalStore.set(R.viewModeAtom(${JSON.stringify(ctx.parentId)}), ${JSON.stringify(mode)});
        return true;`
    );

// Escape where the focus is, so the keybinding dispatcher's window listener sees it as a keypress
const escape = (h) =>
    h.ev(`(document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    )`);

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = { dir: mkdtempSync(join(tmpdir(), "verify-ts-view-")) };
                // a throw past this point still returns ctx, so teardown undoes whatever was already set
                try {
                    Object.assign(ctx, writeSubagentsFixture(ctx.dir, { turnEnded: false }));
                    await arrangeSubagentsAgent(h, ctx, { state: "working" });
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                if (ctx.arrangeError != null) {
                    return [{ step: "arrange the fixture agent", ok: false, detail: ctx.arrangeError }];
                }
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                const find = SUBAGENTS.find;

                const opened = await openChild(h, ctx, find.agentId);
                await polishWaitFor(h, `${flat(`${VIEW}?.querySelector("[data-subagent-now]")`)}.includes("Searched")`, VIEW_WAIT_MS);
                const v1 = await h.ev(viewProbe);
                await h.shot(SHOT(1, "running"));
                rec(
                    "1. opening the running foreground child shows the subagent view: a banner naming Explore, its parent, running, 9 tools, read-only and ↑ parent; full-size steps; no message box; the now line on the running Grep",
                    opened &&
                        v1 != null &&
                        v1.state === "running" &&
                        v1.banner.includes(find.type) &&
                        v1.banner.includes(`subagent of ${PARENT_NAME}`) &&
                        v1.banner.includes("running") &&
                        v1.banner.includes(`${find.tools} tools`) &&
                        v1.banner.includes("read-only") &&
                        v1.banner.includes("↑ parent") &&
                        v1.back &&
                        v1.steps > 0 &&
                        v1.pads.length === 1 &&
                        v1.pads[0] === FULL_STEP_PAD &&
                        v1.boxes === 0 &&
                        v1.nowTitle.startsWith("Searched") &&
                        v1.now.includes(find.current.input.pattern),
                    JSON.stringify({ opened, ...v1 })
                );

                finishSubagent(ctx.childPaths.find);
                await polishWaitFor(
                    h,
                    `(() => { const p = ${viewProbe}; return p?.state === "done" && p.nowTitle === "done"; })()`,
                    LIST_WAIT_MS
                );
                const v2 = await h.ev(viewProbe);
                await h.shot(SHOT(2, "done"));
                rec(
                    "2. after the child finishes, the banner and the now line read done",
                    v2 != null && v2.state === "done" && v2.banner.includes("done") && v2.nowTitle === "done",
                    JSON.stringify(v2)
                );

                await h.ev(`${VIEW}?.querySelector("[data-subagent-back]")?.click()`);
                await polishWaitFor(h, `${VIEW} == null && ${visible(SCROLLER)}`, VIEW_WAIT_MS);
                await h.cdp("Emulation.setDeviceMetricsOverride", SHORT_VIEW);
                let s3;
                try {
                    await polishNap(SCROLL_SETTLE_MS);
                    const before = await h.ev(`(() => {
                        const el = ${SCROLLER};
                        if (!el) return null;
                        el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
                        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
                    })()`);
                    await polishNap(SCROLL_SETTLE_MS);
                    const top = await h.ev(`${SCROLLER}?.scrollTop ?? null`);
                    const tests = await openChild(h, ctx, SUBAGENTS.tests.agentId);
                    const hidden = await h.ev(`!${visible(SCROLLER)}`);
                    await h.shot(SHOT(3, "over-scrolled-parent"));
                    await escape(h);
                    const back = await polishWaitFor(h, `${VIEW} == null && ${visible(SCROLLER)}`, VIEW_WAIT_MS);
                    await polishNap(SCROLL_SETTLE_MS);
                    const after = await h.ev(`${SCROLLER}?.scrollTop ?? null`);
                    s3 = { before, top, tests, hidden, back, after };
                } finally {
                    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
                }
                rec(
                    "3. with the parent scrolled up, Esc from the subagent returns to its Rendered view at the same scroll offset",
                    s3.top > 0 &&
                        s3.tests &&
                        s3.hidden &&
                        s3.back &&
                        s3.after != null &&
                        Math.abs(s3.after - s3.top) <= SCROLL_SLACK_PX,
                    JSON.stringify(s3)
                );

                const TERMINAL = `${SURFACE}?.querySelector('[data-agent-terminal=${JSON.stringify(ctx.parentId)}]')`;
                await setViewMode(h, ctx, "terminal");
                const term = await polishWaitFor(h, `${visible(TERMINAL)} && ${SCROLLER} == null`, VIEW_WAIT_MS);
                const sub4 = await openChild(h, ctx, SUBAGENTS.tests.agentId);
                await h.ev(`${VIEW}?.querySelector("[data-subagent-back]")?.click()`);
                const back4 = await polishWaitFor(h, `${VIEW} == null && ${visible(TERMINAL)}`, VIEW_WAIT_MS);
                const rendered4 = await h.ev(`${SURFACE}?.querySelector("[data-rendered-view]") != null`);
                await h.shot(SHOT(4, "back-to-terminal"));
                await setViewMode(h, ctx, "rendered");
                rec(
                    "4. opened from the Terminal view, ↑ parent returns to the terminal",
                    term && sub4 && back4 && !rendered4,
                    JSON.stringify({ term, sub4, back4, rendered4 })
                );
                return steps;
            },
            teardown: teardownSubagentsAgent,
        },
    ];
}
