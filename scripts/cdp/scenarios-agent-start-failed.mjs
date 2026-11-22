// The Agent surface's start-failure state, through a real refusal of the backend start: two agent tabs made as
// launchAgent makes them (one launchagenttab with the launch and session meta, the start's outcome on the block, a
// pending launch). The failing one's block names a remote connection, which ResyncController refuses before it
// starts anything; the booting one has no controller, so it never starts and stays a pending launch. Nothing runs
// and nothing is written to disk.

import { randomUUID } from "node:crypto";
import { polishWaitFor, waveService, APP_MOD } from "./scenarios-shared.mjs";

const NAME = "agent-start-failed";
const REMOTE_CONN = "ssh:arc-verify-none";
const REFUSAL = "remote connections are not supported";
const ROSTER_WAIT_MS = 5_000;
const REFUSAL_WAIT_MS = 10_000;

// the app's own module instances, and the app's one AgentsViewModel
const LIB = `
    ${APP_MOD}
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const WOS = await mod("app/store/wos.ts");
    // the nav rail, not the Agent tree: with no agent yet the Agent surface renders the launch hero and no tree
    const agentsModel = () => {
        const nav = document.querySelector("nav");
        const key = nav && Object.keys(nav).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? nav[key] : null; f; f = f.return) {
            if (f.memoizedProps?.model?.pendingLaunchesAtom) return f.memoizedProps.model;
        }
        throw new Error("no AgentsViewModel above the nav rail");
    };
`;
const pageEval = (h, body) => h.ev(`(async () => { ${LIB} ${body} })()`);

const focusAgent = (h, tabId) =>
    pageEval(
        h,
        `const model = agentsModel();
        globalStore.set(model.focusIdAtom, ${JSON.stringify(tabId)});
        globalStore.set(model.surfaceAtom, "agent");
        return true;`
    );

const HEADER = `document.querySelector("[data-agent-header]")`;
const headerState = `(() => {
    const hd = ${HEADER};
    if (!hd) return null;
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const pill = hd.querySelector("[data-agent-state-pill]");
    return {
        text: flat(hd),
        pill: flat(pill),
        pillError: pill?.classList.contains("text-error") ?? false,
        error: hd.querySelector("[data-agent-start-error]") ? flat(hd.querySelector("[data-agent-start-error]")) : null,
    };
})()`;

// the dot's fill against the theme's error color, both as the browser computes them
const treeDot = (tabId) => `(() => {
    const dot = document.querySelector('[data-tree-agent="${tabId}"] [data-tree-start-error]');
    if (!dot) return { dot: false };
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--color-error)";
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { dot: true, fill: getComputedStyle(dot).backgroundColor, want };
})()`;

const termLines = (tabId) => `(() => {
    const view = document.querySelector('[data-agent-terminal="${tabId}"] [data-term-view]');
    const key = view && Object.keys(view).find((k) => k.startsWith("__reactFiber$"));
    let tw = null;
    for (let f = key ? view[key] : null; f && !tw; f = f.return) {
        if (f.memoizedProps?.model?.termRef?.current?.terminal) tw = f.memoizedProps.model.termRef.current;
    }
    const b = tw?.terminal.buffer.active;
    const out = [];
    for (let y = 0; b && y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? "");
    return out;
})()`;

// the app's own launch: one launchagenttab that opens and starts the tab, then its start outcome on the block
async function makeAgentTab(h, ctx, label, blockMeta) {
    const made = await pageEval(
        h,
        `const { launchAgentTab, settleLaunchStart } = await mod("app/view/agents/agentcontrollerstore.ts");
        const launched = await launchAgentTab({
            workspaceid: ${JSON.stringify(ctx.workspaceId)},
            tabname: ${JSON.stringify(label)},
            tabmeta: { "session:agent": "claude", "session:project": ${JSON.stringify(label)} },
            blockmeta: ${JSON.stringify(blockMeta)},
            start: true,
        });
        try {
            settleLaunchStart(launched);
        } catch {
            // the refusal is what the steps check; it is returned below
        }
        const model = agentsModel();
        const pending = { tabId: launched.tabid, blockId: launched.blockid, name: ${JSON.stringify(label)},
            project: ${JSON.stringify(label)}, ts: Date.now(), runtime: "claude" };
        globalStore.set(model.pendingLaunchesAtom, [...globalStore.get(model.pendingLaunchesAtom), pending]);
        return { tabId: launched.tabid, startError: launched.starterror ?? null };`
    );
    ctx.tabIds.push(made.tabId);
    return made;
}

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const tag = randomUUID().slice(0, 8);
                const ctx = { tabIds: [] };
                await h.goto("agent");
                const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
                const wslist = await h.rpc("workspacelist", null);
                const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
                ctx.workspaceId = ws.workspacedata.oid;
                // a throw past this point still returns ctx, so teardown closes whatever was already made
                try {
                    // no controller: ResyncController returns without starting anything, so it stays booting
                    ctx.bootingId = (await makeAgentTab(h, ctx, `start-booting-${tag}`, { view: "term" })).tabId;
                    const failing = await makeAgentTab(h, ctx, `start-failed-${tag}`, {
                        view: "term",
                        controller: "cmd",
                        cmd: "claude",
                        "cmd:args": [],
                        "agent:baseargs": [],
                        "cmd:shell": false,
                        "cmd:jwt": true,
                        "cmd:cwd": "~",
                        connection: REMOTE_CONN,
                    });
                    ctx.failingId = failing.tabId;
                    ctx.launchRefusal = failing.startError;
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the agent tabs", false, ctx.arrangeError);
                    return steps;
                }

                await focusAgent(h, ctx.bootingId);
                await polishWaitFor(h, `(${HEADER}?.textContent ?? "").includes("start-booting-")`, ROSTER_WAIT_MS);
                const booting = await h.ev(headerState);
                await h.shot("cdp-shots/agent-start-failed-1-booting.png");
                rec(
                    "1. a booting launch's header names its runtime, not Unknown",
                    booting != null &&
                        booting.text.includes("Claude Code") &&
                        !booting.text.includes("Unknown") &&
                        booting.pill === "working",
                    JSON.stringify(booting)
                );

                await focusAgent(h, ctx.failingId);
                await polishWaitFor(h, `!!${HEADER}?.querySelector("[data-agent-start-error]")`, REFUSAL_WAIT_MS);
                const failed = await h.ev(headerState);
                await h.shot("cdp-shots/agent-start-failed-2-header.png");
                rec(
                    "2. a launch whose controller is refused reads failed to start with the error in the Agent header",
                    (ctx.launchRefusal ?? "").includes(REFUSAL) &&
                        failed != null &&
                        failed.text.includes("start-failed-") &&
                        failed.pill === "failed to start" &&
                        failed.pillError &&
                        (failed.error ?? "").includes(REFUSAL),
                    JSON.stringify({ launchRefusal: ctx.launchRefusal, failed })
                );

                const dot = await h.ev(treeDot(ctx.failingId));
                rec("3. its tree row shows the error tone", dot.dot && dot.fill === dot.want, JSON.stringify(dot));

                const printed = await polishWaitFor(
                    h,
                    `${termLines(ctx.failingId)}.some((l) => l.includes("[arc] could not start:"))`,
                    REFUSAL_WAIT_MS
                );
                const lines = (await h.ev(termLines(ctx.failingId))).filter((l) => l.trim() !== "");
                rec(
                    "4. the terminal prints could not start",
                    printed && lines.some((l) => l.includes("[arc] could not start:") && l.includes(REFUSAL)),
                    JSON.stringify(lines.slice(-4))
                );
                return steps;
            },
            // best-effort, so one failed step does not strand the rest
            async teardown(h, ctx) {
                const step = async (what, fn) => {
                    try {
                        await fn();
                    } catch (e) {
                        console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
                    }
                };
                const ids = JSON.stringify(ctx.tabIds ?? []);
                await step("drop the pending launches", () =>
                    pageEval(
                        h,
                        `const model = agentsModel();
                        const ids = ${ids};
                        globalStore.set(model.pendingLaunchesAtom, globalStore.get(model.pendingLaunchesAtom).filter((p) => !ids.includes(p.tabId)));
                        return true;`
                    )
                );
                for (const tabId of ctx.tabIds ?? []) {
                    await step(`close tab ${tabId}`, () =>
                        waveService(h, "workspace", "CloseTab", [ctx.workspaceId, tabId, false])
                    );
                }
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
