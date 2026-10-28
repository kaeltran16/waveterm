// Helpers more than one scenario module uses. A helper one module uses lives in that module.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A step this profile cannot run: no record holding a decision, no pi session focused. Neither a pass nor a
// failure — report.mjs tallies it apart and exitCode ignores it. The detail must name what to seed, so a
// skip stays a standing invitation to make the step real rather than a permanent shrug.
export const skipStep = (step, detail) => ({ step, skip: true, detail });

// a channel's runs are their own rows: the getchannels reply is channel metadata, with no run list
export async function channelRuns(h, channelId) {
    return (await h.rpc("getchannelruns", { channelid: channelId }))?.runs ?? [];
}

// a current Claude snapshot with FUTURE reset epochs, so both limit bars render and their countdowns are live
export const usageRateLimits = () => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
        claude: {
            fivehourpct: 62,
            fivehourreset: nowSec + 3 * 3600,
            weekpct: 41,
            weekreset: nowSec + 6 * 24 * 3600,
            capturedAt: Date.now(),
        },
    };
};

// an expression that puts a localStorage key back as it was read, removing one that was absent
export function restoreLocalStorage(key, prev) {
    return prev === null ? `localStorage.removeItem('${key}')` : `localStorage.setItem('${key}', ${JSON.stringify(prev)})`;
}
// long enough for a tick that read the dag before the seed to have written it back
export const ATTN_TICK_SETTLE_MS = 2000;

export const git = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], {
        stdio: "pipe",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "dana k",
            GIT_AUTHOR_EMAIL: "dana@example.com",
            GIT_COMMITTER_NAME: "dana k",
            GIT_COMMITTER_EMAIL: "dana@example.com",
        },
    });

// the app's own reload, waited out until the shell is back up
export async function reloadApp(h) {
    try {
        await h.ev("location.reload()");
    } catch {
        /* the evaluate is cut off by the navigation it just started */
    }
    for (let waited = 0; waited < 30000; waited += 500) {
        const up = await h.ev("!!window.TabRpcClient && !!document.querySelector('nav button')").catch(() => false);
        if (up) break;
        await new Promise((r) => setTimeout(r, 500));
    }
}

export const setFinderQuery = (h, text) =>
    h.ev(`(() => {
        const input = document.querySelector('input[data-palette-input]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
    })()`);

export const CTRL = 2; // CDP Input.dispatchKeyEvent modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
export const PROFILE_MODAL = `document.querySelector('[data-jarvis-brief-modal="profile"]')`;

// Opens the Brief's profile modal on a project's Project scope. The modal opens on the first project, so a store
// holding others needs this one picked, through the search box once there are more than the chips show.
export async function openProfileOn(h, name) {
    if (!(await h.ev(`!!${PROFILE_MODAL}`))) {
        await h.ev(`document.querySelector('[data-jarvis-brief-profile]')?.click()`);
        if (!(await polishWaitFor(h, `!!${PROFILE_MODAL}`, 5000))) return false;
    }
    await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-profile-tab="project"]')?.click()`);
    const chip = `${PROFILE_MODAL}?.querySelector('button[title="${name}"]')`;
    if (!(await polishWaitFor(h, `!!${chip}`, 3000))) {
        await h.ev(setInputExpr(`${PROFILE_MODAL}?.querySelector('input[aria-label="Search projects"]')`, name));
        if (!(await polishWaitFor(h, `!!${chip}`, 3000))) return false;
    }
    await h.ev(`${chip}?.click()`);
    // a pick reloads that project's profile, so the rows are read only once they are back
    await polishNap(300);
    return polishWaitFor(
        h,
        `${chip}?.getAttribute('aria-pressed') === 'true' && !!${PROFILE_MODAL}?.querySelector('[role="group"][aria-label="Approvals"]')`,
        5000
    );
}

export async function closeProfile(h) {
    await h.ev(`[...(${PROFILE_MODAL}?.querySelectorAll('footer button') ?? [])].find((b) => b.textContent.trim() === 'Cancel')?.click()`);
    return polishWaitFor(h, `!${PROFILE_MODAL}`, 3000);
}

export const UI_ROUTE = { route: "cockpit", timeout: 15000 };

// The Agent tree and the details rail on the brief type scale (docs/superpowers/specs/2026-09-29-agent-tree-rail-
// polish-design.md): lucide marks instead of text glyphs, and nothing smaller than 10.5px. The roster is a dev
// fixture; the lead's run is a real orchestrator run held by deferstart, so the tree nests the fixture lead under it
// and the rail shows its Run section. agent-tree-rail also gives that run a chained plan, which dispatches one real
// worker (t-1) that teardown deletes, and gives the lead a temp transcript with one working subagent, so the worker
// row, its guide, the task strip and the subagent row are all rendered for the sweeps.
export const TREE_RAIL_FIXTURE = new URL("../../public/cockpit-fixtures/active.json", import.meta.url);
export const TREE_RAIL_LEAD = "tree-rail lead";
export const RAIL_VISIBLE_KEY = "agent.rail.visible";
export const MIN_FONT_PX = 10.5;

// Page functions for the design-rule checks (2026-10-17 drift plan), spliced into an evaluated body:
// floorWalk counts each visible text node under the roots and lists those set under MIN_FONT_PX, or is null when a
// root is missing; rawOverlay says a colour is a translucent white or black, the overlay the theme tokens replaced,
// read off a canvas so any computed syntax (rgba, oklab, color-mix) compares; shadowVs sets an element's computed
// box-shadow beside that of a probe given the token's class, both without the zero-sized layers tailwind stacks under
// it. The probe takes the class rather than var(--token): tailwind emits a theme variable only into the utilities
// that use it. A class used only under a container variant goes on a probe inside a container of the given width.
const PAINT_LIB = `
    const floorWalk = (roots) => {
        if (roots.some((r) => r == null)) return null;
        const offenders = [];
        let seen = 0;
        for (const root of roots) {
            const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                const text = n.data.trim();
                if (!text) continue;
                const range = document.createRange();
                range.selectNodeContents(n);
                const r = range.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const cs = getComputedStyle(n.parentElement);
                if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
                seen++;
                if (parseFloat(cs.fontSize) < ${MIN_FONT_PX}) offenders.push(text.slice(0, 40) + " @" + cs.fontSize);
            }
        }
        return { seen, offenders };
    };
    const rgbaOf = (color) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const x = c.getContext("2d");
        x.fillStyle = color;
        x.fillRect(0, 0, 1, 1);
        return [...x.getImageData(0, 0, 1, 1).data];
    };
    const rawOverlay = (color) => {
        const [r, g, b, a] = rgbaOf(color);
        return a > 0 && a < 255 && ((r >= 250 && g >= 250 && b >= 250) || (r <= 5 && g <= 5 && b <= 5));
    };
    const shadowLayers = (s) =>
        s === "none" ? "" : s.split(/,(?![^(]*\\))/).map((t) => t.trim()).filter((t) => !/0px 0px 0px 0px$/.test(t)).join(", ");
    const shadowVs = (el, cls, containerPx) => {
        const wrap = document.createElement("div");
        if (containerPx != null) wrap.style.cssText = "container-type:inline-size;width:" + containerPx + "px";
        const probe = document.createElement("div");
        probe.className = cls;
        wrap.append(probe);
        document.body.append(wrap);
        const want = shadowLayers(getComputedStyle(probe).boxShadow);
        wrap.remove();
        if (el == null) return { found: false, want };
        const cs = getComputedStyle(el);
        const got = shadowLayers(cs.boxShadow);
        return { found: true, got, want, bg: cs.backgroundColor, raw: rawOverlay(cs.backgroundColor), ok: want !== "" && got === want && !rawOverlay(cs.backgroundColor) };
    };
`;
export const paintEval = (h, body) => h.ev(`(async () => { ${PAINT_LIB} ${body} })()`);
// the active surface: the region beside the nav rail
export const SURFACE_ROOT = `document.querySelector("nav")?.nextElementSibling`;
export const floorOk = (s) => s != null && s.seen > 0 && s.offenders.length === 0;
export const floorDetail = (s) => (s == null ? "a root is missing" : `checked ${s.seen} text nodes; offenders=${JSON.stringify(s.offenders)}`);

// the floor check on the view under each root expression, as a step
export async function floorStep(h, step, ...roots) {
    const s = await paintEval(h, `return floorWalk([${roots.join(", ")}]);`);
    return { step, ok: floorOk(s), detail: floorDetail(s) };
}

export const TREE_RAIL_LEAD_ID = "fx-lead";

export function treeRailRoster(runId, now, leadName = TREE_RAIL_LEAD, leadExtra = {}) {
    return [
        {
            id: TREE_RAIL_LEAD_ID,
            name: leadName,
            project: "waveterm",
            task: "verify tree rail",
            state: "working",
            agent: "claude",
            model: "opus",
            activeMs: 240_000,
            runId,
            blockId: "fx-blk-lead",
            ...leadExtra,
        },
        {
            id: "fx-ask-wave",
            name: "wave asker",
            project: "waveterm",
            task: "pick a packaging track",
            state: "asking",
            model: "opus",
            blockedMs: 120_000,
            blockId: "fx-blk-ask-wave",
        },
        {
            id: "fx-ask-siem",
            name: "siem asker",
            project: "siem-platform",
            task: "pick a detector track",
            state: "asking",
            model: "opus",
            blockedMs: 60_000,
            blockId: "fx-blk-ask-siem",
        },
        {
            id: "fx-idle",
            name: "idle scribe",
            project: "siem-platform",
            task: "release notes",
            state: "idle",
            model: "sonnet",
            idleSince: now - 60_000,
            blockId: "fx-blk-idle",
        },
    ];
}

// a real orchestrator run held in planning, and the fixture roster whose lead carries its id
export async function arrangeFixtureRun(h, ctx, label, leadName, leadExtra, runExtra) {
    const wslist = await h.rpc("workspacelist", null);
    const ch = await h.rpc("createchannel", { name: `verify-${label}`, projectpath: ctx.cwd });
    ctx.channelId = ch.oid;
    const created = await h.rpc("createrun", {
        channelid: ctx.channelId,
        workspaceid: wslist[0].workspacedata.oid,
        goal: `verify ${label}: do nothing`,
        runtime: "claude",
        mode: "orchestrator",
        deferstart: true,
        ...runExtra,
    });
    ctx.runId = created.run.id;
    ctx.landPath = created.run.landpath;
    mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
    writeFileSync(
        TREE_RAIL_FIXTURE,
        JSON.stringify(treeRailRoster(ctx.runId, Date.now(), leadName, leadExtra), null, 2)
    );
    ctx.wroteFixture = true;
}

// t-1's dispatch has taken anywhere from 0.2s to 28s on the dev app, the slow ones right after another scenario
const DISPATCH_WAIT_MS = 60_000;

// polls the run's DAG until the task has a worker run, recording the outcome and the wait on ctx
export async function waitForDispatch(h, ctx, taskId) {
    const start = Date.now();
    while (!ctx.dispatched && Date.now() - start < DISPATCH_WAIT_MS) {
        const group = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
        ctx.dispatched = !!group?.tasks?.find((t) => t.id === taskId)?.runid;
        if (!ctx.dispatched) await new Promise((r) => setTimeout(r, 500));
    }
    ctx.dispatchMs = Date.now() - start;
}

// best-effort, so one failed worker does not strand the rest; the failures are thrown after, for the caller to log
export async function deleteChannelWorkerBlocks(h, channelId) {
    const failed = [];
    for (const run of await channelRuns(h, channelId)) {
        for (const phase of run.phases || []) {
            for (const oref of phase.workerorefs || []) {
                try {
                    const tab = await waveService(h, "object", "GetObject", [oref]);
                    const bid = tab && tab.blockids && tab.blockids[0];
                    if (bid) await h.rpc("deleteblock", { blockid: bid });
                } catch (e) {
                    failed.push(`${oref}: ${e?.message ?? e}`);
                }
            }
        }
    }
    if (failed.length) throw new Error(failed.join("; "));
}

// a fixture repo's linked worktrees: the run's landing tree and its lanes' trees
function linkedWorktrees(cwd) {
    if (!cwd || !existsSync(join(cwd, ".git"))) return [];
    const out = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const trees = out
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => resolve(line.slice("worktree ".length).trim()));
    // the first is the repo's own checkout
    return trees.slice(1);
}

export async function teardownFixtureRun(h, ctx, name, restore) {
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`${name} teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    if (ctx.wroteFixture) await step("remove the fixture roster", () => rmSync(TREE_RAIL_FIXTURE, { force: true }));
    if (restore) await step(restore.what, restore.fn);
    if (ctx.runId) {
        await step("cancel the run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId }));
    }
    if (ctx.channelId) {
        // cancelling a run stops its workers but leaves their blocks
        await step("delete the worker blocks", () => deleteChannelWorkerBlocks(h, ctx.channelId));
        await step("delete the channel", () => h.rpc("deletechannel", { channelid: ctx.channelId }));
    }
    await step("reload onto the live roster", () => h.reload());
    // engine trees live under the arc-wt root, not the temp dir, and a cancel leaves the landing tree: only a land
    // removes it. A worker just stopped holds its lane's tree for a moment, hence the retries.
    const trees = new Set(ctx.landPath ? [resolve(ctx.landPath)] : []);
    await step("list the run's trees", () => linkedWorktrees(ctx.cwd).forEach((tree) => trees.add(tree)));
    for (const tree of trees) {
        await step(`remove the run tree ${tree}`, () =>
            rmSync(tree, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
        );
    }
    await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
    const left = [...trees].filter((tree) => existsSync(tree));
    if (left.length) throw new Error(`${name} teardown: run trees left behind: ${left.join(", ")}`);
    if (trees.size) console.log(`${name} teardown: run trees gone: ${[...trees].join(", ")}`);
}
export const COCKPIT = `document.querySelector("[data-cockpit-surface]")`;
export const COCKPIT_LEAD_CARD = `${COCKPIT}?.querySelector('[data-agent-id="${TREE_RAIL_LEAD_ID}"]')`;

// The Jarvis run sheet on the brief type scale (docs/superpowers/specs/2026-09-29-run-sheet-polish-design.md):
// nothing under 10.5px in the sheet body or its header, the shared task strip under the verb, and the compact
// lifecycle timeline. The run is a real orchestrator run held by deferstart, then given a chained three-task plan,
// so only t-1 dispatches a worker; teardown cancels the run, which cancels its DAG and that worker.
export const RUN_SHEET_POLISH_TASKS = [
    { id: "t-1", label: "noop", description: "do nothing, stop immediately", deps: [], state: "" },
    { id: "t-2", label: "noop 2", description: "do nothing, stop immediately", deps: ["t-1"], state: "" },
    { id: "t-3", label: "noop 3", description: "do nothing, stop immediately", deps: ["t-2"], state: "" },
];

// A deferred orchestrator run in a temp dir, given a plan, with its sheet opened on the Brief. A throw lands in
// ctx.arrangeError and still returns ctx, so teardown removes whatever was already made.
export async function arrangeSheetDagRun(h, label, tasks) {
    const cwd = mkdtempSync(join(tmpdir(), `verify-${label}-`));
    const ctx = { cwd };
    try {
        const wslist = await h.rpc("workspacelist", null);
        const ch = await h.rpc("createchannel", { name: `verify-${label}`, projectpath: cwd });
        ctx.channelId = ch.oid;
        const created = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid: wslist[0].workspacedata.oid,
            goal: `verify ${label}: do nothing, make no file changes, stop immediately`,
            runtime: "claude",
            mode: "orchestrator",
            deferstart: true,
        });
        ctx.runId = created.run.id;
        await h.rpc("dagsubmit", {
            channelid: ctx.channelId,
            runid: ctx.runId,
            title: `verify ${label}`,
            parallelism: 1,
            tasks,
        });
        // the Brief reads a boot-primed snapshot, so the RPC-created channel needs a reload
        await h.ev("location.reload()");
        await h.ev(`(async () => {
            for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                await new Promise((r) => setTimeout(r, 500));
            }
        })()`);
        await h.goto("jarvis");
        ctx.opened = await h.ev(`(async () => {
            for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
            return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
        })()`);
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
    }
    return ctx;
}

export const OBS_WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
// below TIMELINE_RAIL_MIN_PX (1100), where the lifecycle rail collapses into a drawer
export const OBS_NARROW = { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false };

const FINAL_SHOTS_CMD = "node scripts/cdp/final-verify.mjs final-shots";
const FINAL_SHOTS_SEED_KEY = "verify:finalshots-seed";
export const FINAL_SHOTS_UICTX = { windowid: "", activetabid: "" };

const finalFingerprint = (final, past) =>
    JSON.stringify([final?.state, final?.round, final?.shots?.length ?? 0, (past ?? []).map((p) => p.shots?.length ?? 0)]);

// Puts the stored dag into a state the engine has not reached: change maps the dag as read to the dag to
// write, and print reduces a dag to what the seed must hold.
export async function seedDag(h, ctx, change, print) {
    const oref = `dag:${ctx.dagId}`;
    let want = null;
    let stored = null;
    // the watchdog ticks a running dag, and a tick that read the dag before this write lands over it
    for (let i = 0; i < 3 && (stored == null || print(stored) !== want); i++) {
        const next = { ...change(await waveService(h, "object", "GetObject", [oref])), otype: "dag" };
        want = print(next);
        await waveService(h, "object", "UpdateObject", [next, false], FINAL_SHOTS_UICTX);
        stored = await waveService(h, "object", "GetObject", [oref]);
    }
    if (print(stored) !== want) {
        throw new Error(`the dag did not keep its seed: want ${want}, stored ${print(stored)}`);
    }
    // UpdateObject publishes nothing; a meta write sends the whole stored dag to the page
    ctx.seeds = (ctx.seeds ?? 0) + 1;
    await h.rpc("setmeta", { oref, meta: { [FINAL_SHOTS_SEED_KEY]: ctx.seeds } });
}

export const seedFinalShots = (h, ctx, { final, pastfinals }) =>
    seedDag(
        h,
        ctx,
        (dag) => ({ ...dag, finalcmd: FINAL_SHOTS_CMD, final, pastfinals }),
        (dag) => finalFingerprint(dag?.final, dag?.pastfinals)
    );
// Part B's commands are only drawn, never run
export const FST_CHECK = "node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit";
const FST_VERIFY = "node scripts/verify.mjs ./pkg/waveobj";
const FST_COMMIT = "c0ffee5a".padEnd(40, "0");
export const FST_DETAIL = [
    `Final \`${FINAL_SHOTS_CMD}\` failed (exit 1):`,
    "FAIL jarvis-peek 4. the narrow panel stays bounded with a pinned header, no horizontal overflow, and an unclipped harness picker",
    "FAIL jarvis-peek 5. attention expands the card and keyboard navigation moves the cursor then focuses the composer",
    "2 of 43 steps failed across 5 scenarios",
].join("\n");
export const FST_UNVERIFIED =
    "verifier: the narrow jarvis-peek panel could not be compared with its board, because the board has no artboard at 440px wide";
// the Passed row's step times; with the verifier's they total the board's 14m 22s
const FST_STEP_MS = { tree: 22_000, check: 41_000, verify: 431_000, final: 188_000 };

// A run's events cannot be written through an RPC. The page appends every run:event it receives to that run's
// list, so a published one stands for the engine's until the next reload.
async function fstPublishSteps(h, ctx, round, steps) {
    const ts = Date.now();
    for (const [step, [ms, ok]] of Object.entries(steps)) {
        const event = {
            id: `fst-${round}-${step}`,
            runid: ctx.runId,
            channelid: ctx.channelId,
            ts,
            kind: "final-step",
            detail: JSON.stringify({ round, step, ms, ok }),
        };
        await h.rpc("eventpublish", {
            event: "run:event",
            scopes: [`run:${ctx.runId}`],
            data: { channelid: ctx.channelId, runid: ctx.runId, event },
        });
    }
}

const fstStagePrint = (f) =>
    f == null
        ? null
        : [f.state ?? "", f.round ?? 0, f.step ?? "", f.verifierrunid ?? "", (f.unverified ?? []).length, (f.detail ?? "").length, (f.shots ?? []).length];
const fstSeedPrint = (dag) =>
    JSON.stringify([dag?.check ?? "", dag?.verify ?? "", dag?.finalcmd ?? "", fstStagePrint(dag?.final), (dag?.pastfinals ?? []).map(fstStagePrint)]);

// one States row: the dag's commands, its final and past finals, and the round's step events
function fstStage(ctx, name, { verifier = true, skip } = {}) {
    const now = Date.now();
    const five = { check: FST_CHECK, verify: FST_VERIFY, finalcmd: FINAL_SHOTS_CMD };
    // where the engine would have made the stage's tree; nothing is there
    const tree = { tree: `${ctx.cwd.replace(/\\/g, "/")}/.waveterm/worktrees/${ctx.runId}-final`, commit: FST_COMMIT };
    const round1 = { ...ctx.shotsRound1, detail: FST_DETAIL, ...tree };
    const past = [round1];
    const ok = (steps) => Object.fromEntries(steps.map((s) => [s, [FST_STEP_MS[s], true]]));
    const commands = ["tree", "check", "verify", "final"].filter((s) => s !== skip);
    const judged = { round: 2, verifierrunid: ctx.verifierRunId, startedts: ctx.verifierStart, ...tree };
    switch (name) {
        case "waiting":
            return { cmds: five };
        case "tree":
            return {
                cmds: five,
                final: { state: "checking", round: 1, step: "tree", stepts: now - 22_000, startedts: now - 22_000 },
            };
        case "alongside":
            return {
                cmds: { check: FST_CHECK, verify: FST_VERIFY },
                final: {
                    state: "checking",
                    round: 1,
                    step: "check",
                    stepts: now - 11_000,
                    startedts: now - 9_000,
                    verifierrunid: ctx.verifierRunId,
                    ...tree,
                },
                events: [1, ok(["tree"])],
            };
        case "reviewing":
            return {
                cmds: five,
                final: {
                    state: "verifying",
                    round: 2,
                    startedts: now - 242_000,
                    ...(verifier ? { verifierrunid: ctx.verifierRunId } : {}),
                    ...tree,
                },
                pastfinals: past,
                events: [2, ok(commands)],
            };
        case "failed":
            return { cmds: five, final: round1, events: [1, { ...ok(["tree", "check", "verify"]), final: [125_000, false] }] };
        case "fixing":
            return { cmds: five, final: { state: "", round: 2 }, pastfinals: past };
        case "unverified":
            return {
                cmds: five,
                final: { state: "unverified", unverified: [FST_UNVERIFIED], ...judged },
                pastfinals: past,
                events: [2, ok(commands)],
            };
        case "passed":
            return { cmds: five, final: { state: "passed", ...judged }, pastfinals: past, events: [2, ok(commands)] };
    }
    throw new Error(`no final-stage row named ${name}`);
}

// seeds a States row and publishes its events; returns the publish, for fstUntil to repeat
export async function fstShow(h, ctx, name, opts) {
    const { cmds, final, pastfinals, events } = fstStage(ctx, name, opts);
    await seedDag(
        h,
        ctx,
        (dag) => {
            const { final: _final, pastfinals: _past, check: _check, verify: _verify, finalcmd: _cmd, ...rest } = dag;
            return { ...rest, ...cmds, ...(final ? { final } : {}), ...(pastfinals ? { pastfinals } : {}) };
        },
        fstSeedPrint
    );
    const publish = events ? () => fstPublishSteps(h, ctx, ...events) : undefined;
    if (publish) await publish();
    return { nudge: publish };
}

// object.UpdateObject publishes nothing, so the stored run is sent to the page as the update it would have been
export async function fstWriteRun(h, runId, change) {
    const oref = `run:${runId}`;
    const next = { ...change(await waveService(h, "object", "GetObject", [oref])), otype: "run" };
    await waveService(h, "object", "UpdateObject", [next, false], FINAL_SHOTS_UICTX);
    const stored = await waveService(h, "object", "GetObject", [oref]);
    await h.rpc("eventpublish", {
        event: "waveobj:update",
        scopes: [oref],
        data: { updatetype: "update", otype: "run", oid: runId, obj: { ...stored, otype: "run" } },
    });
    return stored;
}
export const polishNap = (ms) => new Promise((r) => setTimeout(r, ms));

export async function polishWaitFor(h, expr, ms) {
    for (let waited = 0; waited < ms; waited += 250) {
        if (await h.ev(expr).catch(() => false)) return true;
        await polishNap(250);
    }
    return false;
}

// createproject only writes projects.json; the server's config watcher picks it up a moment later, and a reload
// before then boots a frontend whose project list lacks it until the next config event
export async function waitForProjectInConfig(h, name) {
    for (let waited = 0; waited < 10000; waited += 250) {
        const cfg = await h.rpc("getfullconfig", null);
        if (cfg?.projects?.[name] != null) return;
        await polishNap(250);
    }
    throw new Error(`project ${name} never reached the config`);
}

export async function polishReload(h) {
    try {
        await h.ev("location.reload()");
    } catch {
        /* the evaluate is cut off by the navigation it just started */
    }
    await polishWaitFor(h, "!!window.TabRpcClient && !!document.querySelector('nav button')", 30000);
    await h.goto("jarvis");
}
export const PEEKS_ESC = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`;

export const MODELS_PLAN = fileURLToPath(new URL("./fixtures/models-plan.md", import.meta.url));
// narrow columns defeat by-name clicks, and verify.mjs clears any earlier override
export const MODELS_VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
export const setInputExpr = (elExpr, value) => `(() => {
    const el = ${elExpr};
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
})()`;
export const flatText = (elExpr) => `(${elExpr}?.textContent ?? '').replace(/\\s+/g, ' ').trim()`;

// the window's header carries the marker, so its dialog scopes every query to it
export const NEW_RUN = `document.querySelector('[data-new-run-window]')?.closest('[role="dialog"]')`;
export const NEW_RUN_FIELD = `${NEW_RUN}?.querySelector('button[aria-haspopup="listbox"]')`;
export const NEW_RUN_LIST = `${NEW_RUN}?.querySelector('[role="listbox"][aria-label="Projects"]')`;

export const openAddressExpr = (address) => `(async () => {
    for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
        await new Promise((r) => setTimeout(r, 250));
    }
    if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
    return window.__openAddress(${JSON.stringify(address)});
})()`;
export const NEW_RUN_GOAL = `${NEW_RUN}?.querySelector('textarea[aria-label="Goal"]')`;

export const PALETTE_INPUT = `document.querySelector('input[data-palette-input]')`;
export const PALETTE = `${PALETTE_INPUT}?.closest('[role="dialog"]')`;
// React reads keys off the input's own keydown, so they are dispatched there rather than relying on page focus
export const paletteKey = (key, mods = {}) => `(() => {
    const el = ${PALETTE_INPUT};
    if (!el) return false;
    el.dispatchEvent(new KeyboardEvent('keydown', { ...${JSON.stringify(mods)}, key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true }));
    return true;
})()`;
export const PALETTE_TOGGLE = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`;
// the listbox's children are its groups, each led by its label; a row is a data-idx button
export const PALETTE_STATE = `(() => {
    const d = ${PALETTE};
    if (!d) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const input = d.querySelector('input[data-palette-input]');
    const list = d.querySelector('[role="listbox"][aria-label="Results"]');
    const sel = list?.querySelector('button[data-idx][aria-selected="true"]');
    return {
        token: d.querySelector('[data-palette-token]') ? flat(d.querySelector('[data-palette-token]')) : null,
        drill: d.querySelector('[data-palette-drill]') ? flat(d.querySelector('[data-palette-drill]')) : null,
        query: input?.value ?? null,
        placeholder: input?.placeholder ?? null,
        groups: [...(list?.children ?? [])].map((g) => ({
            label: flat(g.firstElementChild),
            rows: [...g.querySelectorAll('button[data-idx]')].map((b) => flat(b)),
        })),
        selected: sel ? flat(sel) : null,
        chip: sel ? /→ \\d+ actions/.test(flat(sel)) : false,
        text: (d.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    };
})()`;

export async function openPalette(h) {
    // Ctrl+P toggles, so a palette an earlier step left open is closed first
    if (await h.ev(`!!${PALETTE_INPUT}`)) {
        await h.ev(PEEKS_ESC);
        await polishWaitFor(h, `!${PALETTE_INPUT}`, 2000);
    }
    await h.ev(PALETTE_TOGGLE);
    return polishWaitFor(h, `!!${PALETTE_INPUT}`, 3000);
}

export async function paletteStateWhen(h, ok, ms) {
    let state = null;
    for (let waited = 0; waited <= ms; waited += 250) {
        state = await h.ev(PALETTE_STATE).catch(() => null);
        if (state != null && ok(state)) break;
        await polishNap(250);
    }
    return state;
}
export const RUN_SHEET = `document.querySelector('[data-run-sheet]')`;
export const clickByText = (scopeExpr, selector, text) =>
    `[...((${scopeExpr})?.querySelectorAll(${JSON.stringify(selector)}) ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`;
// an own property over Clipboard.prototype's: never the real write, which a window without OS focus rejects and
// which would overwrite the user's clipboard
export const notesClipStub = (rejects) => `(() => {
    window.__notesClip = [];
    navigator.clipboard.writeText = (text) => {
        window.__notesClip.push(text);
        return ${rejects ? `Promise.reject(new Error('denied'))` : `Promise.resolve()`};
    };
    return true;
})()`;
export const NOTES_CLIP_RESTORE = `(() => { delete navigator.clipboard.writeText; delete window.__notesClip; return true; })()`;

export const CANVAS_TOPIC = "verify-canvas";
export const CANVAS_PANE = `document.querySelector("[data-canvas-pane]")`;

// a method that takes a UIContext (object.UpdateObject) refuses a call without one
export async function waveService(h, service, method, args, uicontext = null) {
    const [endpoint, key] = await h.ev(`[window.api.getEnv("WAVE_SERVER_WEB_ENDPOINT"), window.api.getAuthKey()]`);
    const res = await fetch(`http://${endpoint}/wave/service?service=${service}&method=${method}`, {
        method: "POST",
        headers: { "x-authkey": key },
        body: JSON.stringify({ service, method, args, uicontext }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body == null || body.error) {
        throw new Error(`${service}.${method}: ${body?.error ?? `HTTP ${res.status}`}`);
    }
    return body.data;
}

// the workspace of the page's own tab, so the terminal lands in the window under test
export async function openCanvasTerminal(h, ctx, topic = CANVAS_TOPIC) {
    const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
    const wslist = await h.rpc("workspacelist", null);
    const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
    ctx.workspaceId = ws.workspacedata.oid;
    ctx.tabId = await waveService(h, "workspace", "CreateTab", [ctx.workspaceId, topic, false]);
    const tab = await waveService(h, "object", "GetObject", [`tab:${ctx.tabId}`]);
    ctx.blockId = tab?.blockids?.[0];
    if (!ctx.blockId) throw new Error("the new tab has no block");
    // the shell starts in ~, not the temp dir: something in the app tree keeps its cwd locked until the app exits,
    // so teardown could not delete it. The reveal names its cwd itself (callercwd), so this changes nothing tested
    await h.rpc("setmeta", {
        oref: `block:${ctx.blockId}`,
        meta: { view: "term", controller: "shell", "cmd:cwd": "~" },
    });
    await h.rpc("setmeta", { oref: `tab:${ctx.tabId}`, meta: { "session:project": topic } });
}

export const pressCanvasKey = async (h, { key, code, keyCode }) => {
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key, windowsVirtualKeyCode: keyCode });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    await polishNap(500);
};

export const BS_TOPIC = "consumer-lag-alerts";
export const BS_SPEC = "docs/superpowers/specs/2026-10-18-consumer-lag-alerts-design.md";
export const BS_BOARDS = ["Page.dc.html", "PageB.dc.html"];
export const BS_PANE = `document.querySelector("[data-brainstorm-pane]")`;
export const BS_SWITCH = `document.querySelector('[role="group"][aria-label="Show terminal or brainstorm"]')`;
// BRAINSTORM_POLL_MS is 3s, so a write shows inside two ticks
export const BS_POLL_WAIT_MS = 7000;

// the copy is the canvas's (.superpowers/design/brainstorm-mode): Main's parts and history, Handoff's check
export const BS_PART = {
    intent: {
        title: "Intent and why",
        from: "answer 1",
        body: "When a consumer group falls behind, the people who own it hear first, not an analyst downstream. Last Tuesday enrichment fell two hours behind before anyone knew.",
    },
    goals: {
        title: "Goals",
        from: "answer 2",
        body: "On-call is paged only when lag keeps growing. #siem-ops gets a heads-up at 10 minutes so someone can look before it becomes a page.",
    },
    anti: {
        title: "Anti-goals",
        from: "answer 3",
        body: "A 3am page for a rebalance that recovers by itself in 40 seconds. Any alert that fires during a planned replay.",
    },
    current: {
        title: "Current state",
        from: "recon",
        body: "kafka-exporter already scrapes 14 consumer groups into Prometheus; 3 of them are enrichment. There are no lag rules in Alertmanager today.",
    },
    constraints: {
        title: "Constraints",
        from: "answer 2",
        body: "Alerts go through the existing Alertmanager and its Slack and PagerDuty receivers. No new service, no new bot.",
    },
    thresholds: {
        title: "When it pages",
        from: "answer 4",
        body: "Page when lag on any enrichment partition has grown for 5 straight minutes and is past 15 minutes. A rebalance that recovers inside 2 minutes never pages.",
    },
    page: {
        title: "What on-call sees",
        from: "mockup",
        body: "The page leads with the lag, the trend and how many partitions are stuck, then links the runbook and the Grafana panel.",
        boards: BS_BOARDS,
    },
    builder: {
        title: "Left to the builder",
        from: "",
        body: "Filled in last: the parts you hand over, such as rule file layout and test fixtures.",
    },
};
export const BS_Q1 = { n: 1, text: "What is the moment you found yourself wishing this existed?", part: "intent" };
// the copy of the asking state is the canvas's (.superpowers/design/brainstorm-question-center): a question with
// why, lettered answers with the agent's pick, and in the rail every option a past question offered
export const BS_Q4_OPTIONS = [
    {
        label: "After 15 minutes of growth",
        detail: "Pages only for lag that keeps building. A slow leak can sit under it for a while.",
        pick: true,
    },
    { label: "Past a fixed lag of 100k messages", detail: "Simple to reason about, but a quiet group never gets there." },
    { label: "Whenever any partition is behind", detail: "Nothing slips by, and every rebalance pages someone." },
];
export const BS_Q4 = {
    n: 4,
    text: "When lag keeps growing on an enrichment partition, when should on-call get paged?",
    part: "thresholds",
    why: "kafka-exporter already reports lag per partition, so each of these is one alert rule. What I can’t tell from the repo is how long enrichment can fall behind before analysts notice.",
    options: BS_Q4_OPTIONS,
};
export const BS_Q2_OPTIONS = [
    { label: "Page on-call for every lag alert", detail: "" },
    { label: "On-call only if it keeps growing; the channel hears at 10 minutes", detail: "", pick: true },
    { label: "Tell the channel only, page no one", detail: "" },
];
// oldest first, as the agent appends them and the pane draws them
export const BS_HISTORY = [
    {
        kind: "question",
        n: 1,
        q: BS_Q1.text,
        a: "Last Tuesday, when enrichment was two hours behind and we heard it from an analyst.",
        into: ["intent"],
    },
    {
        kind: "question",
        n: 2,
        q: "Who gets woken up, and who just needs to know?",
        a: BS_Q2_OPTIONS[1].label,
        into: ["goals", "constraints"],
        options: BS_Q2_OPTIONS,
        picked: 1,
    },
    {
        kind: "question",
        n: 3,
        q: "What would make you wince if I got this wrong?",
        a: "Paging at 3am for a rebalance that fixes itself in 40 seconds.",
        into: ["anti"],
    },
    {
        kind: "recon",
        q: "I offered to look at your Prometheus targets and Alertmanager rules. You said yes.",
        a: "14 consumer groups scraped by kafka-exporter, 3 on enrichment. No lag rules yet.",
        into: ["current"],
    },
];
export const BS_ANSWER_LINES = ["Once it has grown for 5 straight minutes and is past 15 minutes.", "A rebalance that recovers inside 2 minutes never pages."];
// answered in the user's own words, not one of the options: the rail draws it after them as In your words
export const BS_HISTORY_Q4 = [
    ...BS_HISTORY,
    { kind: "question", n: 4, q: BS_Q4.text, a: BS_ANSWER_LINES.join(" "), into: ["thresholds"], options: BS_Q4_OPTIONS },
];
export const BS_BUILDER_Q = "When a lag page fires, should it also hold the enrichment autoscaler at its current size, or only report?";
export const BS_BUILDER_A = "Only report. Scaling stays a human call.";

export const bsParts = (states, over = {}) =>
    Object.entries(states).map(([id, state]) => ({ id, state, ...BS_PART[id], ...(over[id] ?? {}) }));
export const bsFile = (over) => ({
    v: 1,
    title: "Consumer lag alerts",
    spec: BS_SPEC,
    canvas: BS_TOPIC,
    question: null,
    working: null,
    parts: [],
    history: [],
    done: false,
    check: null,
    run: null,
    ...over,
});
export const BS_HANDOFF_PARTS = bsParts(Object.fromEntries(Object.keys(BS_PART).map((id) => [id, "yours"])), {
    intent: { body: "When a consumer group falls behind, the people who own it hear first, not an analyst downstream." },
    thresholds: {
        body: "Page when lag on any enrichment partition has grown for 5 straight minutes and is past 15 minutes.",
    },
    anti: { body: "A 3am page for a rebalance that recovers by itself. Any alert during a planned replay." },
    builder: { body: "Rule file layout, test fixtures for the recording rules, the runbook’s wording." },
});
export const BS_CHECK = {
    yours: [
        {
            q: BS_BUILDER_Q,
            why: "Holding it changes what gets built: the rule then needs write access to the autoscaler.",
        },
    ],
    calls: [
        {
            text: "Lag is judged per partition, not per group: one stuck partition hides in a group average.",
            part: "thresholds",
        },
        { text: "The 15-minute line lives in the alert rules per consumer group, not in code.", part: "thresholds" },
        { text: "Planned replays are silenced by an Alertmanager silence the replay script creates.", part: "anti" },
    ],
    answered: [
        "Which exporter? kafka-exporter, from the recon.",
        "Does two hours of lag lose data? No: topic retention is 7 days.",
    ],
    touched: ["intent", "thresholds", "anti", "builder"],
};
export const BS_HANDOFF = bsFile({ done: true, parts: BS_HANDOFF_PARTS, history: BS_HISTORY_Q4, check: BS_CHECK });
export const BS_HANDOFF_ANSWERED = {
    ...BS_HANDOFF,
    check: { ...BS_CHECK, yours: [{ ...BS_CHECK.yours[0], a: BS_BUILDER_A, into: "anti" }] },
};

// clicks the button labelled `label` inside the scope, and says what it found
export const bsClick = (h, scope, label) =>
    h.ev(`(() => {
        const b = [...(${scope}?.querySelectorAll("button") ?? [])]
            .find((x) => (x.textContent || "").replace(/\\s+/g, " ").trim() === ${JSON.stringify(label)});
        if (!b) return "missing";
        if (b.disabled) return "disabled";
        b.click();
        return "clicked";
    })()`);

export const bsPublishStatus = (h, ctx) =>
    h.rpc("eventpublish", {
        event: "agent:status",
        scopes: [`block:${ctx.blockId}`],
        persist: 1,
        data: { oref: `block:${ctx.blockId}`, state: "idle", agent: "claude", cwd: ctx.cwd, ts: Date.now() },
    });

export const bsReveal = (h, ctx, topic) =>
    h.rpc("uireveal", { address: `brainstorm:${topic}`, callerblockid: ctx.blockId, callercwd: ctx.cwd }, UI_ROUTE);

export async function bsShowPane(h) {
    if (await h.ev(`!!${BS_PANE}`)) return true;
    await bsClick(h, BS_SWITCH, "Brainstorm");
    return polishWaitFor(h, `!!${BS_PANE}`, 3000);
}
// the serve call, a canvas.json read and the board HEADs all land inside one 3s poll tick; two ticks is the margin
export const CANVAS_TABS_WAIT_MS = 8000;
export const focusAgentXterm = `(() => {
    const t = [...document.querySelectorAll('.xterm-helper-textarea')].find((x) => x.checkVisibility());
    t?.focus();
    return t != null;
})()`;

export const LOOK_LIB = `
    const mod = async (path) => {
        const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
        const hit = names.filter((n) => n.endsWith("/" + path)).pop();
        const base = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
        if (hit == null && base == null) throw new Error("no app module url for " + path);
        return import(hit ?? base.replace("app/store/jotaiStore.ts", path));
    };
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 8000) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await nap(150)) if (fn()) return true;
        return !!fn();
    };
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const button = (from, re) => [...(from?.querySelectorAll("button") ?? [])].find((b) => re.test(flat(b)));
    // the topmost: a sheet is a modal dialog too, and a confirm opens over it
    const dialog = () => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].pop() ?? null;
    // a pre-bundled dependency at the url the app loaded it from: another url is another instance, a second React
    const dep = (name) => {
        const hit = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.split("?")[0].endsWith("/.vite/deps/" + name + ".js"));
        if (hit == null) throw new Error("no vite dep url for " + name);
        return import(hit);
    };
    // renders a component of the app's module into a host pinned over the page, under the app's jotai store unless
    // given another; host.render(props) re-renders it. unmountAll removes every host.
    const mount = async (path, name, props, { store, style = "" } = {}) => {
        const [R, RD, J, S, M] = await Promise.all([dep("react"), dep("react-dom_client"), dep("jotai"), mod("app/store/jotaiStore.ts"), mod(path)]);
        const React = R.default ?? R;
        const host = document.createElement("div");
        host.setAttribute("data-look-mount", name);
        host.style.cssText = "position:fixed;left:120px;top:90px;z-index:9000;padding:12px;background:var(--color-background);" + style;
        document.body.append(host);
        const root = (RD.createRoot ?? RD.default.createRoot)(host);
        host.render = (p) => root.render(React.createElement(J.Provider, { store: store ?? S.globalStore }, React.createElement(M[name], p)));
        host.render(props);
        (window.__lookMounts ??= []).push({ root, host });
        await nap(250);
        return host;
    };
    const unmountAll = () => {
        for (const { root, host } of window.__lookMounts ?? []) {
            root.unmount();
            host.remove();
        }
        window.__lookMounts = [];
    };
    ${PAINT_LIB}
`;
export const lookEval = (h, body) => h.ev(`(async () => { ${LOOK_LIB} ${body} })()`);
export const lookShot = (name) => `cdp-shots/look-${name}.png`;

export async function lookOpen(h, surface) {
    await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
    await h.goto(surface);
}

// a real pointer move, so floating-ui's hover and React's mouseenter see what a user's pointer does
export async function lookHover(h, x, y) {
    await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

// Holds a view in its loading frame through the app's module: an RpcApi command that never replies, or a wave
// object read back to loading with its fetch dropped. Each release puts the real one back.
export const holdRpc = (h, command) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        (window.__heldRpc ??= {})[${JSON.stringify(command)}] ??= RpcApi[${JSON.stringify(command)}];
        RpcApi[${JSON.stringify(command)}] = () => new Promise(() => {});
    `);
export const releaseRpc = (h, command) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const held = window.__heldRpc?.[${JSON.stringify(command)}];
        if (held) RpcApi[${JSON.stringify(command)}] = held;
        delete window.__heldRpc?.[${JSON.stringify(command)}];
    `);

// The Skeleton placeholders under a root (Skeleton draws animate-pulse on bg-edge-strong), each with its size and
// corner, and a step on the one at index i against what its class names: height or min-height in px, the width as a
// share of its parent, the radius.
export const lookPlaceholders = (h, root) =>
    lookEval(h, `
        const all = () => [...((${root})?.querySelectorAll(".animate-pulse.bg-edge-strong") ?? [])];
        await until(() => all().length > 0, 4000);
        await nap(300);
        return all().map((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const pcs = getComputedStyle(el.parentElement);
            const room = el.parentElement.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight);
            return {
                height: Math.round(r.height * 10) / 10,
                share: Math.round((r.width / room) * 100),
                minHeight: cs.minHeight,
                radius: cs.borderTopLeftRadius,
            };
        });
    `);
export function placeholderStep(step, got, want, i = 0) {
    const p = got[i];
    const ok =
        p != null &&
        p.radius === want.radius &&
        (want.height == null || Math.abs(p.height - want.height) < 0.6) &&
        (want.minHeight == null || (p.minHeight === `${want.minHeight}px` && p.height >= want.minHeight)) &&
        Math.abs(p.share - (want.share ?? 100)) <= 1;
    return { step, ok, detail: JSON.stringify({ got: p ?? null, of: got.length, want }) };
}

// the shown tooltip's look: both tooltips share one, a bordered floating surface on the popover shadow scale
export const LOOK_TOOLTIP_STYLE = `(() => {
    const t = [...document.querySelectorAll("[data-tooltip]")].find((d) => d.style.opacity !== "0");
    if (t == null) return null;
    const cs = getComputedStyle(t);
    return { text: t.innerText, border: cs.borderTopWidth, size: cs.fontSize, shadow: cs.boxShadow !== "none" };
})()`;
export const tooltipLookOk = (look) => look?.border === "1px" && look?.size === "11.5px" && look?.shadow === true;

export async function lookKey(h, key, code, keyCode) {
    for (const type of ["keyDown", "keyUp"]) await h.cdp("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
}

// the helpers the sessions scenario modules seed their run with (sessions-search-fixtures.mjs)
export const SESSIONS_KIT = { teardownFixtureRun, fstWriteRun, waveService };
