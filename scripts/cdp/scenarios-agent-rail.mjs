// Agent review scenario `agent-rail`: the details rail's footer action (F4, F9, F18), its Session line (F10), the
// silent Files touched reload (F5), the token headline (F17) and the shared-checkout summary (F19). The roster is a
// fixture whose block ids are real tabs with no controller, so nothing runs; every transcript sits in a temp dir
// beside a temp git repo it names as its cwd. Teardown closes the tabs, restores the roster and the rail toggle, and
// removes the temp dir.
//
// Steps 2, 3, 6 and 7 read what the shell-owned stream fills (the focused agent's entries, its shell tasks, every
// streamed agent's cwd), so they hold on the merged tree, where that owner runs on the Agent surface too.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    interrupted,
    makeTab,
    quietUntil,
    restoreRoster,
    setRoster,
    toolUse,
    usage,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { git, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "agent-rail";
const WAIT_MS = 8_000;
// a fresh app's first git reads in a new repo can take a while
const GIT_WAIT_MS = 20_000;
const QUIET_MIN = 4;
const MS_PER_MINUTE = 60_000;
const EDITED_FILE = "notes.md";
// one agent's usage: 524,600 tokens in all, 24,600 of them new
const USAGE = { input: 1200, output: 3400, cacheRead: 500_000, cacheWrite: 20_000 };
const TOTAL_LABEL = "525K";
const NEW_LABEL = "25K";
const ASK_HINT = "waiting on you · answer in the terminal";
const QUIET_HINT = `quiet · no output ${QUIET_MIN}m · Esc also stops`;

const RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const HEADER = `document.querySelector("[data-agent-header]")`;
const railView = `(() => {
    const rail = ${RAIL};
    if (!rail) return null;
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const hint = rail.querySelector("[data-rail-hint]");
    const probe = document.createElement("span");
    probe.style.color = "var(--color-warning)";
    document.body.appendChild(probe);
    const warning = getComputedStyle(probe).color;
    probe.remove();
    const summary = rail.querySelector("[data-rail-files-summary]");
    return {
        text: flat(rail),
        hint: hint ? flat(hint) : null,
        hintWarning: hint != null && getComputedStyle(hint).color === warning,
        stop: rail.querySelector('button[title="interrupt the current turn"]') != null,
        resume: rail.querySelector('button[title="nudge the agent to continue from idle"]') != null,
        state: flat(rail.querySelector("[data-rail-state]")) || null,
        pill: flat(${HEADER}?.querySelector("[data-agent-state-pill]")) || null,
        summary: summary ? flat(summary) : null,
        summaryTitle: summary?.getAttribute("title") ?? null,
        usage: flat(rail.querySelector("[data-token-usage]")) || null,
    };
})()`;

// the records claude writes when a Bash call starts in the background, so the agent stands by on a real shell task
function shellStart(id, dir, cwd) {
    const toolUseId = `toolu_${id}`;
    const output = join(dir, `${id}.output`);
    writeFileSync(output, "running\n");
    const timestamp = new Date().toISOString();
    return [
        JSON.stringify({
            type: "assistant",
            timestamp,
            cwd,
            message: {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: toolUseId,
                        name: "Bash",
                        input: { command: "./serve.sh", description: "serve the preview", run_in_background: true },
                    },
                ],
            },
        }),
        JSON.stringify({
            type: "user",
            timestamp,
            cwd,
            message: {
                role: "user",
                content: [
                    {
                        tool_use_id: toolUseId,
                        type: "tool_result",
                        content: `Command running in background with ID: ${id}. Output is being written to: ${output}.`,
                        is_error: false,
                    },
                ],
            },
            toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: id },
        }),
    ];
}

const rosterAgent = (id, blockId, name, state, transcriptPath, extra = {}) => ({
    id,
    name,
    task: "rail fixture",
    state,
    agent: "claude",
    project: name,
    blockId,
    transcriptPath,
    ...(state === "idle" ? { idleSince: Date.now() - 2 * MS_PER_MINUTE } : {}),
    ...extra,
});

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const tag = randomUUID().slice(0, 8);
                const ctx = { tabIds: [] };
                await h.goto("agent");
                try {
                    ctx.root = mkdtempSync(join(tmpdir(), "verify-agent-rail-"));
                    const repo = join(ctx.root, "repo");
                    const dir = join(ctx.root, "transcripts");
                    mkdirSync(repo);
                    mkdirSync(dir);
                    ctx.repo = repo;
                    git(repo, "init", "-q", "--initial-branch=main");
                    writeFileSync(join(repo, EDITED_FILE), "# notes\n");
                    git(repo, "add", ".");
                    git(repo, "commit", "-q", "-m", "seed the notes");

                    const o = { cwd: repo };
                    const paths = {
                        ask: writeTranscript(dir, "ask", [userText("pick a parser", o), usage({ ...USAGE, ...o })]),
                        done: writeTranscript(dir, "done", [
                            userText("tidy the notes", o),
                            usage({ ...USAGE, ...o }),
                            assistantText("Done: the notes are tidy.", o),
                        ]),
                        cut: writeTranscript(dir, "cut", [
                            userText("rewrite the notes", o),
                            usage({ ...USAGE, ...o }),
                            assistantText("Starting on the rewrite.", o),
                            interrupted(o),
                        ]),
                        standing: writeTranscript(dir, "standing", [
                            userText("serve the preview", o),
                            usage({ ...USAGE, ...o }),
                            ...shellStart("bshrailserve", dir, repo),
                        ]),
                        working: writeTranscript(dir, "working", [
                            userText("run the long build", o),
                            usage({ ...USAGE, ...o }),
                            toolUse("toolu_railbuild", "Bash", { command: "make all" }, o),
                        ]),
                    };
                    ctx.ids = {};
                    const roster = [];
                    const states = { ask: "asking", done: "idle", cut: "idle", standing: "idle", working: "working" };
                    for (const [key, state] of Object.entries(states)) {
                        const label = `rail-${key}-${tag}`;
                        // the rail reads the block's cwd before the transcript's, and a focused tab's shell would
                        // otherwise stamp its own there
                        const tab = await makeTab(h, ctx, { label, blockMeta: { view: "term", "cmd:cwd": repo } });
                        ctx.ids[key] = { tabId: tab.tabId, blockId: tab.blockId, label };
                        roster.push(rosterAgent(tab.tabId, tab.blockId, label, state, paths[key]));
                    }
                    await setRoster(h, roster);
                    await agentPage(
                        h,
                        `const { railVisibleAtom } = await mod("app/view/agents/railstore.ts");
                        if (!("__railVisiblePrev" in window)) window.__railVisiblePrev = globalStore.get(railVisibleAtom);
                        globalStore.set(railVisibleAtom, true);
                        return true;`
                    );
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the fixture", false, ctx.arrangeError);
                    return steps;
                }
                const focus = async (key) => {
                    await focusAgent(h, ctx.ids[key].tabId);
                    await polishWaitFor(
                        h,
                        `(${HEADER}?.textContent ?? "").includes(${JSON.stringify(ctx.ids[key].label)}) && ${RAIL} != null`,
                        WAIT_MS
                    );
                };
                const waitRail = (cond, ms = WAIT_MS) =>
                    polishWaitFor(h, `(() => { const v = ${railView}; return v != null && (${cond}); })()`, ms);
                const view = () => h.ev(railView);

                await focus("ask");
                await waitRail(`v.hint != null`);
                const ask = await view();
                await h.shot("cdp-shots/agent-rail-1-asking.png");
                rec(
                    "1. an asking agent's footer says to answer in the terminal and offers no Stop",
                    ask?.hint === ASK_HINT && !ask.stop && !ask.resume,
                    JSON.stringify(ask)
                );

                await focus("done");
                await waitRail(`v.state != null`);
                const done = await view();
                await h.shot("cdp-shots/agent-rail-2-finished.png");
                await focus("cut");
                await waitRail(`v.resume`);
                const cut = await view();
                await h.shot("cdp-shots/agent-rail-2-interrupted.png");
                rec(
                    "2. an idle agent that finished offers no Resume; one whose last turn was interrupted does",
                    done != null && !done.resume && done.hint == null && cut?.resume === true,
                    JSON.stringify({ done, cut })
                );

                // set after focusing: a focused tab's terminal may print, which moves the stamp to now
                const makeQuiet = (seen) => quietUntil(h, ctx.ids.working.blockId, QUIET_MIN, seen);
                const same = {};
                let quietAttempts;
                for (const [key, expect] of [
                    ["done", "idle"],
                    ["standing", "standing by"],
                    ["working", `quiet ${QUIET_MIN}m`],
                ]) {
                    await focus(key);
                    const seen = () => waitRail(`v.state === ${JSON.stringify(expect)} && v.pill === v.state`);
                    if (key === "working") quietAttempts = await makeQuiet(seen);
                    else await seen();
                    const v = await view();
                    same[key] = { state: v?.state, pill: v?.pill };
                    await h.shot(`cdp-shots/agent-rail-3-${key}.png`);
                }
                rec(
                    "3. the rail's Session line reads as the header pill for idle, standing by and quiet agents",
                    same.done?.state === "idle" &&
                        same.standing?.state === "standing by" &&
                        same.working?.state === `quiet ${QUIET_MIN}m` &&
                        Object.values(same).every((s) => s.state === s.pill),
                    JSON.stringify({ ...same, attempts: quietAttempts })
                );

                await focus("done");
                await waitRail(`v.text.includes("No changes") || v.summary != null`, GIT_WAIT_MS);
                await agentPage(
                    h,
                    `const { railStateAtom } = await mod("app/view/agents/railstore.ts");
                    window.__railBlanked = false;
                    window.__railUnsub?.();
                    window.__railUnsub = globalStore.sub(railStateAtom, () => {
                        if (globalStore.get(railStateAtom) == null) window.__railBlanked = true;
                    });
                    return true;`
                );
                writeFileSync(join(ctx.repo, EDITED_FILE), "# notes\n\nan edit the rail should pick up\n");
                await h.rpc("setmeta", { oref: `block:${ctx.ids.done.blockId}`, meta: { "agent:lasteditts": Date.now() } });
                const reloaded = await waitRail(`v.text.includes(${JSON.stringify(EDITED_FILE)})`, GIT_WAIT_MS);
                const blanked = await agentPage(
                    h,
                    `window.__railUnsub?.(); delete window.__railUnsub; return window.__railBlanked;`
                );
                const edited = await view();
                await h.shot("cdp-shots/agent-rail-4-reload.png");
                rec(
                    "4. an edit stamp shows the edited file in Files touched without refocusing, never blanking the list",
                    reloaded && blanked === false,
                    JSON.stringify({ blanked, summary: edited?.summary })
                );

                await waitRail(`v.usage != null && v.usage.includes("new tokens")`);
                const tokens = (await view())?.usage ?? "";
                await h.shot("cdp-shots/agent-rail-5-tokens.png");
                const totals = tokens.split(TOTAL_LABEL).length - 1;
                rec(
                    "5. Token usage shows the total once and new tokens as its headline",
                    totals === 1 && tokens.includes(`${NEW_LABEL}new tokens`) && tokens.includes(`${TOTAL_LABEL} total`),
                    JSON.stringify({ totals, tokens })
                );

                await waitRail(`(v.summary ?? "").startsWith("repo · ")`, GIT_WAIT_MS);
                const shared = await view();
                await h.shot("cdp-shots/agent-rail-6-shared.png");
                rec(
                    "6. agents sharing the repo make Files touched read as the repo's, with the shared title",
                    (shared?.summary ?? "").startsWith("repo · ") &&
                        /^All changes in this checkout, shared by \d+ agents$/.test(shared?.summaryTitle ?? ""),
                    JSON.stringify({ summary: shared?.summary, title: shared?.summaryTitle })
                );

                await focus("working");
                const hintAttempts = await makeQuiet(() => waitRail(`v.hint === ${JSON.stringify(QUIET_HINT)}`));
                const quiet = await view();
                await h.shot("cdp-shots/agent-rail-7-quiet.png");
                rec(
                    `7. a working agent silent for ${QUIET_MIN} minutes shows the quiet hint, warning-toned, beside Stop`,
                    quiet?.hint === QUIET_HINT && quiet.hintWarning && quiet.stop,
                    JSON.stringify({ ...quiet, attempts: hintAttempts })
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
                await step("clear the last-output stamp", () =>
                    agentPage(
                        h,
                        `const { getLastOutputAtom } = await mod("app/view/agents/agentcontrollerstore.ts");
                        globalStore.set(getLastOutputAtom(${JSON.stringify(ctx.ids?.working?.blockId ?? "")}), undefined);
                        return true;`
                    )
                );
                await step("restore the rail toggle", () =>
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
                await step("restore the roster", () => restoreRoster(h));
                await step("close the tabs", () => closeTabs(h, ctx));
                await step("remove the temp dir", async () => {
                    if (ctx.root) rmSync(ctx.root, { recursive: true, force: true });
                });
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
