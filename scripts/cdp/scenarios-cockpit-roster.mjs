// Cockpit review scenarios: roster, counts and empty states.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    lookEval,
    lookOpen,
    polishNap,
    polishReload,
    setInputExpr,
    TREE_RAIL_FIXTURE,
    waitForProjectInConfig,
    waveService,
} from "./scenarios-shared.mjs";

const PROJECT = "fx-roster";
const EMPTY_SCOPE = "fx-roster-none";
const OLD_IDLE_MS = 10 * 60_000; // well past the idle grace window, so the agent parks
const SETTLE_MS = 700; // a RollingCount's roll and a card's entrance
// unique per run, so a leftover tab of an earlier run can never take this project's name
const LAUNCH_PROJECT = `verify-roster-launch-${Date.now().toString(36)}`;
// a harmless process that outlives the step and reports no agent status, so its card stays booting; closing its tab ends it
const LAUNCH_COMMAND = "ping -n 900 127.0.0.1";
const FLAGS_KEY = "agent.launch.flags";
const RECENT_KEY = "agent.launch.recentprojects";
const MODAL_WAIT_MS = 15_000;

const said = (text) => [{ kind: "message", text }];
const working = (id) => ({
    id,
    name: id,
    project: PROJECT,
    task: "",
    state: "working",
    agent: "claude",
    model: "opus",
    activeMs: 60_000,
    blockId: `blk-${id}`,
    previousInfo: said("Working through the fixture task."),
});
const idle = (id, now) => ({ ...working(id), state: "idle", idleSince: now - OLD_IDLE_MS, activeMs: OLD_IDLE_MS });
// no transcript, no prior output and no activity: nothing for its card to show yet, as at a trust prompt
const bare = (id) => ({ ...working(id), previousInfo: undefined });

// the app's own model and atoms, reached from the cockpit's React props, as scenarios-agent.mjs does
const APP = `
    const S = (await mod("app/store/jotaiStore.ts")).globalStore;
    const D = await mod("app/view/agents/devmock.ts");
    const T = await mod("app/view/agents/shelltasksstore.ts");
    const surface = () => document.querySelector("[data-cockpit-surface]");
    await until(() => surface() != null, 8000);
    const key = Object.keys(surface()).find((k) => k.startsWith("__reactFiber$"));
    let model;
    for (let f = surface()[key]; f && !model; f = f.return) if (f.memoizedProps?.model?.surfaceAtom) model = f.memoizedProps.model;
    if (model == null) throw new Error("no cockpit model in the React tree");
    const tabs = () => Object.fromEntries(
        [...surface().querySelectorAll("button")]
            .map((b) => flat(b).match(/^(\\d+)\\s*(need you|working|ready for review|live)$/))
            .filter(Boolean)
            .map((m) => [m[2], Number(m[1])])
    );
    const fact = () => flat(surface()).match(/\\d+ agents? · \\d+ projects? · \\d+ need you/)?.[0] ?? null;
`;

// one roster state, set through the app's atoms, then what the cockpit shows for it
function show(h, { roster, pending = [], backgrounded = [], filter = "all", liveOnly = false }, read) {
    return lookEval(h, `
        ${APP}
        S.set(model.projectFilterAtom, ${JSON.stringify(filter)});
        S.set(model.liveOnlyAtom, ${liveOnly});
        S.set(model.backgroundedIdsAtom, new Set(${JSON.stringify(backgrounded)}));
        S.set(model.pendingLaunchesAtom, ${JSON.stringify(pending)});
        S.set(D.devMockAgentsAtom, ${JSON.stringify(roster)});
        await nap(${SETTLE_MS});
        ${read}
    `);
}

// a card's waiting body, and whether a "starting" line sits above it
const WAITING_READ = (id) => `
    const card = () => surface().querySelector('[data-agent-id="${id}"]');
    await until(() => card()?.querySelector("[data-card-waiting]") != null, 8000);
    const waiting = card()?.querySelector("[data-card-waiting]");
    const starting = [...(card()?.querySelectorAll("span") ?? [])].find((s) => flat(s) === "starting");
    return {
        waiting: flat(waiting),
        openTerminal: waiting?.querySelector('button[title="Open terminal"]') != null,
        starting: starting != null,
        startingAbove: starting != null && waiting != null && (starting.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        surface: S.get(model.surfaceAtom),
        tabs: tabs(),
        fact: fact(),
    };
`;

const newAgentModal = `() => [...document.querySelectorAll('[role="dialog"]')].find((d) => /New agent/.test(flat(d.querySelector("h2"))))`;

// New agent on the Cockpit, as cockpit-launch-stays drives it: the scoped project, the Claude Code runtime (a
// pending card and a started controller) and LAUNCH_COMMAND, launched once the modal has closed on success
async function launchFromNewAgent(h) {
    const opened = await lookEval(h, `
        ${APP}
        const { naFlagsAtom } = await mod("app/view/agents/naflagsstore.ts");
        const modal = ${newAgentModal};
        // a remembered flag would be appended to the command and make it exit
        S.set(naFlagsAtom, {});
        S.set(model.newAgentOpenAtom, true);
        const picked = () => modal()?.querySelector('[role="radiogroup"][aria-label="Project"] [aria-checked="true"]');
        await until(() => picked() != null, 5000);
        button(modal()?.querySelector('[role="radiogroup"][aria-label="Runtime"]'), /Claude Code/)?.click();
        await nap(300);
        return { preselected: flat(picked()) };
    `);
    await h.ev(setInputExpr(`document.getElementById("na-cmd")`, LAUNCH_COMMAND));
    const launched = await lookEval(h, `
        ${APP}
        const modal = ${newAgentModal};
        await nap(200);
        button(modal(), /^Launch agent/)?.click();
        const closed = await until(() => modal() == null, ${MODAL_WAIT_MS});
        const pending = S.get(model.pendingLaunchesAtom).find((p) => p.project === ${JSON.stringify(LAUNCH_PROJECT)});
        return { closed, error: closed ? null : flat(modal()), tabId: pending?.tabId ?? null };
    `);
    return { ...opened, ...launched };
}

async function arrange(h) {
    const ctx = { tabIds: [] };
    try {
        mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
        writeFileSync(TREE_RAIL_FIXTURE, "[]");
        ctx.wroteFixture = true;
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
        return ctx;
    }
    // the launch step's project, registered as New project does; a failure here fails only that step
    try {
        ctx.dir = mkdtempSync(join(tmpdir(), "verify-roster-launch-"));
        ctx.prevFlags = await h.ev(`localStorage.getItem(${JSON.stringify(FLAGS_KEY)})`);
        ctx.prevRecent = await h.ev(`localStorage.getItem(${JSON.stringify(RECENT_KEY)})`);
        const r = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { atoms } = await mod("app/store/global-atoms.ts");
            const ps = await mod("app/view/agents/projectsstore.ts");
            await ps.registerProject(${JSON.stringify(LAUNCH_PROJECT)}, ${JSON.stringify(ctx.dir)});
            const listed = await until(() => globalStore.get(ps.projectListAtom).some((p) => p.name === ${JSON.stringify(LAUNCH_PROJECT)}), 10000);
            return { listed, workspaceId: globalStore.get(atoms.workspace)?.oid ?? null };
        `);
        ctx.madeProject = true;
        ctx.workspaceId = r.workspaceId;
        if (!r.listed) throw new Error(`project ${LAUNCH_PROJECT} never reached the project list`);
        // assert reloads, and a frontend booted before the config has it would not list the project
        await waitForProjectInConfig(h, LAUNCH_PROJECT);
    } catch (e) {
        ctx.launchError = String(e?.message ?? e);
    }
    return ctx;
}

async function assert(h, ctx) {
    if (ctx.arrangeError) {
        return [{ step: "cockpit-roster-counts: arrange", ok: false, detail: ctx.arrangeError }];
    }
    // the fixture roster is read once at boot
    await polishReload(h);
    await lookOpen(h, "cockpit");
    const steps = [];
    const run = async (step, fn) => {
        try {
            const r = await fn();
            steps.push({ step, ok: !!r.ok, detail: JSON.stringify(r) });
        } catch (e) {
            steps.push({ step, ok: false, detail: String(e?.message ?? e) });
        }
    };
    const now = Date.now();

    await run("a booting launch's status line reads starting and it counts in agents and live, not working", () =>
        show(
            h,
            {
                roster: [working("fx-roster-work")],
                pending: [{ tabId: "fx-roster-boot", blockId: "blk-fx-roster-boot", name: "booting", project: PROJECT, ts: now }],
            },
            `
            const card = () => surface().querySelector('[data-agent-id="fx-roster-boot"]');
            await until(() => /starting/.test(flat(card())), 4000);
            const t = tabs();
            const r = { starting: /starting/.test(flat(card())), tabs: t, fact: fact() };
            r.ok = r.starting && t.working === 1 && t.live === 2 && /^2 agents · 1 project ·/.test(r.fact ?? "");
            return r;
            `
        )
    );

    await run("the toolbar reads 1 agent · 1 project for one agent", () =>
        show(h, { roster: [working("fx-roster-work")] }, `
            const r = { fact: fact() };
            r.ok = /^1 agent · 1 project · 0 need you$/.test(r.fact ?? "");
            return r;
        `)
    );

    await run("with every agent parked, the grid shows Nothing live: N idle, M backgrounded below and the Idle list stays clickable", async () => {
        const r = await show(
            h,
            { roster: [idle("fx-roster-idle", now), working("fx-roster-bg")], backgrounded: ["fx-roster-bg"] },
            `
            const notice = surface().querySelector('[data-cockpit-grid-notice="nothing-live"]');
            const header = [...surface().querySelectorAll("h2")].find((x) => flat(x) === "Idle")?.parentElement;
            const rect = header?.getBoundingClientRect();
            const at = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
            return {
                notice: flat(notice),
                cards: surface().querySelectorAll("[data-agent-id]").length,
                headerHit: header != null && header.contains(at),
                x: rect ? rect.x + rect.width / 2 : null,
                y: rect ? rect.y + rect.height / 2 : null,
            };
            `
        );
        // a real pointer click on the Idle header opens the list
        if (r.x != null) {
            await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
        }
        await polishNap(SETTLE_MS);
        r.rowShown = await lookEval(h, `
            const row = [...document.querySelectorAll("[data-cockpit-surface] b")].find((b) => flat(b) === "fx-roster-idle");
            const rect = row?.getBoundingClientRect();
            return rect != null && row.parentElement.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        `);
        r.ok = r.notice === "Nothing live: 1 idle, 1 backgrounded below" && r.cards === 0 && r.headerHit && r.rowShown;
        return r;
    });

    await run("a scope with no agents shows No agents in <project> and scoped counts", () =>
        show(h, { roster: [working("fx-roster-work")], filter: EMPTY_SCOPE }, `
            const notice = surface().querySelector('[data-cockpit-grid-notice="empty-scope"]');
            const r = { notice: flat(notice), fact: fact(), tabs: tabs() };
            r.ok = r.notice === "No agents in ${EMPTY_SCOPE}" && r.fact === "0 agents · 0 projects · 0 need you" && r.tabs.live === 0;
            return r;
        `)
    );

    await run("the header switcher's New project is clickable over the empty state", async () => {
        const r = await show(h, { roster: [] }, `
            await until(() => [...surface().querySelectorAll("h2")].some((x) => flat(x) === "No agents running"), 4000);
            surface().querySelector('[data-project-switcher="header"]')?.click();
            await nap(500);
            const item = button(surface(), /^New project$/);
            const rect = item?.getBoundingClientRect();
            const x = rect ? rect.x + rect.width / 2 : null;
            const y = rect ? rect.y + rect.height / 2 : null;
            return {
                empty: [...surface().querySelectorAll("h2")].some((x) => flat(x) === "No agents running"),
                hit: item != null && item.contains(document.elementFromPoint(x, y)),
                x,
                y,
            };
        `);
        if (r.x != null) {
            await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
        }
        await polishNap(SETTLE_MS);
        r.opened = await lookEval(h, `
            ${APP}
            const opened = S.get(model.newProjectOpenAtom) === true;
            S.set(model.newProjectOpenAtom, false);
            return opened;
        `);
        r.ok = r.empty && r.hit && r.opened;
        return r;
    });

    await run("a standing-by agent counts under working, not ready for review, and stays under Live only", async () => {
        const stand = idle("fx-roster-stand", now);
        // the shell-task poll clears a list it cannot read back, so the task goes in just before each read
        const task = `S.set(T.shellTasksByIdAtom, { ...S.get(T.shellTasksByIdAtom), "fx-roster-stand": [{ id: "fx-bg", kind: "shell", description: "dev server" }] });`;
        const read = `
            ${task}
            await nap(${SETTLE_MS});
            return { tabs: tabs(), card: surface().querySelector('[data-agent-id="fx-roster-stand"]') != null };
        `;
        const all = await show(h, { roster: [stand] }, `await nap(${SETTLE_MS}); ${read}`);
        const live = await show(h, { roster: [stand], liveOnly: true }, read);
        const r = { all, live };
        r.ok =
            all.card && all.tabs.working === 1 && all.tabs["ready for review"] === 0 && live.card && live.tabs.working === 1;
        return r;
    });

    await run("an agent with no transcript shows a Waiting in its terminal card and is counted", async () => {
        const r = await show(h, { roster: [working("fx-roster-work"), bare("fx-roster-bare")] }, WAITING_READ("fx-roster-bare"));
        await h.shot("cdp-shots/cockpit-roster-waiting.png");
        // a plain working agent, not a booting one: no "starting" line, and it counts under working
        r.ok =
            r.waiting === "Waiting in its terminal" &&
            r.openTerminal &&
            !r.starting &&
            r.tabs.working === 2 &&
            r.tabs.live === 2 &&
            /^2 agents · 1 project ·/.test(r.fact ?? "");
        return r;
    });

    await run("a launch from the Cockpit shows a Waiting in its terminal card", async () => {
        if (ctx.launchError) throw new Error(`arrange: ${ctx.launchError}`);
        // the fixture agent is in another project, so the scoped counts hold only the launch
        await show(h, { roster: [working("fx-roster-work")], filter: LAUNCH_PROJECT }, "return null;");
        const launched = await launchFromNewAgent(h);
        if (launched.tabId) ctx.tabIds.push(launched.tabId);
        if (launched.tabId == null) return { ok: false, launched };
        const r = await lookEval(h, `${APP} ${WAITING_READ(launched.tabId)}`);
        await h.shot("cdp-shots/cockpit-roster-launch-waiting.png");
        r.launched = launched;
        // booting: "starting" above the waiting row, counted in agents and live but not in working
        r.ok =
            launched.preselected === LAUNCH_PROJECT &&
            r.surface === "cockpit" &&
            r.waiting === "Waiting in its terminal" &&
            r.openTerminal &&
            r.startingAbove &&
            r.tabs.live === 1 &&
            r.tabs.working === 0 &&
            /^1 agent · 1 project ·/.test(r.fact ?? "");
        return r;
    });

    await h.shot("cdp-shots/cockpit-roster-counts.png");
    return steps;
}

async function teardown(h, ctx) {
    if (ctx.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`cockpit-roster-counts teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    for (const tabId of ctx.tabIds ?? []) {
        await step("close the launched tab", () => waveService(h, "workspace", "CloseTab", [ctx.workspaceId, tabId, false]));
    }
    if ("prevFlags" in ctx) {
        await step("restore the launch flags and recent projects", () =>
            lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const { naFlagsAtom } = await mod("app/view/agents/naflagsstore.ts");
                const { recentProjectsAtom } = await mod("app/view/agents/projectsstore.ts");
                globalStore.set(naFlagsAtom, JSON.parse(${JSON.stringify(ctx.prevFlags ?? "{}")}));
                globalStore.set(recentProjectsAtom, JSON.parse(${JSON.stringify(ctx.prevRecent ?? "[]")}));
            `)
        );
    }
    if (ctx.madeProject) await step("delete the project", () => h.rpc("deleteproject", { name: LAUNCH_PROJECT }));
    if (ctx.dir) await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 }));
    try {
        await lookEval(h, `
            ${APP}
            S.set(model.projectFilterAtom, "all");
            S.set(model.liveOnlyAtom, false);
            S.set(model.backgroundedIdsAtom, new Set());
            S.set(model.pendingLaunchesAtom, []);
        `);
    } catch {
        /* the reload below starts from the live roster either way */
    }
    await polishReload(h);
    await h.goto("cockpit");
}

export const cockpitRosterCounts = {
    name: "cockpit-roster-counts",
    surface: "cockpit",
    arrange,
    assert,
    teardown,
};
