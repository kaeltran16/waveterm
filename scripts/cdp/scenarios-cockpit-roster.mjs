// Cockpit review scenarios: roster, counts and empty states.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { lookEval, lookOpen, polishNap, polishReload, TREE_RAIL_FIXTURE } from "./scenarios-shared.mjs";

const PROJECT = "fx-roster";
const EMPTY_SCOPE = "fx-roster-none";
const OLD_IDLE_MS = 10 * 60_000; // well past the idle grace window, so the agent parks
const SETTLE_MS = 700; // a RollingCount's roll and a card's entrance

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

async function arrange() {
    const ctx = {};
    try {
        mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
        writeFileSync(TREE_RAIL_FIXTURE, "[]");
        ctx.wroteFixture = true;
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
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

    await h.shot("cdp-shots/cockpit-roster-counts.png");
    return steps;
}

async function teardown(h, ctx) {
    if (ctx.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
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
