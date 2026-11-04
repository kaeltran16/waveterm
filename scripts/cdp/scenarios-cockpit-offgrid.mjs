// Cockpit review scenarios: Backgrounded and Idle sections.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { lookEval, lookOpen, polishReload, TREE_RAIL_FIXTURE } from "./scenarios-shared.mjs";

const PROJECT = "fx-offgrid";
const OLD_IDLE_MS = 10 * 60_000; // well past the idle grace window, so the agent parks
const SETTLE_MS = 700; // a card's entrance and the tracking effects behind it

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
// an idle agent carries idleSince only, as agentVMFromInput writes it: the age must come from it
const idle = (id, idleSince) => ({ ...working(id), state: "idle", idleSince, activeMs: undefined });
const asking = (id) => ({
    ...working(id),
    state: "asking",
    activeMs: undefined,
    blockedMs: 30_000,
    ask: {
        askId: `ask-${id}`,
        oref: `block:blk-${id}`,
        questions: [{ header: "Order", question: "Which order?", options: [{ label: "first" }, { label: "second" }] }],
    },
});

// the app's own model and atoms, reached from the cockpit's React props, as scenarios-cockpit-roster.mjs does
const APP = `
    const S = (await mod("app/store/jotaiStore.ts")).globalStore;
    const D = await mod("app/view/agents/devmock.ts");
    const surface = () => document.querySelector("[data-cockpit-surface]");
    await until(() => surface() != null, 8000);
    const key = Object.keys(surface()).find((k) => k.startsWith("__reactFiber$"));
    let model;
    for (let f = surface()[key]; f && !model; f = f.return) if (f.memoizedProps?.model?.surfaceAtom) model = f.memoizedProps.model;
    if (model == null) throw new Error("no cockpit model in the React tree");
    const card = (id) => surface().querySelector('[data-agent-id="' + id + '"]');
    const cardIds = () => [...surface().querySelectorAll("[data-agent-id]")].map((el) => el.getAttribute("data-agent-id"));
    const header = (label) => [...surface().querySelectorAll("h2")].find((x) => flat(x) === label)?.parentElement ?? null;
    const sectionRow = (name) => [...surface().querySelectorAll("b")].find((b) => flat(b) === name)?.parentElement ?? null;
    const railRow = (name) =>
        [...document.querySelectorAll('[aria-label="Events"] [role="button"]')].find((r) => flat(r).startsWith(name));
    const setRoster = async (roster) => {
        S.set(D.devMockAgentsAtom, roster);
        await nap(${SETTLE_MS});
    };
`;

const step = (h, body) => lookEval(h, `${APP} ${body}`);

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
        return [{ step: "cockpit-offgrid: arrange", ok: false, detail: ctx.arrangeError }];
    }
    // the fixture roster is read once at boot
    await polishReload(h);
    await lookOpen(h, "cockpit");
    const steps = [];
    const run = async (name, fn) => {
        try {
            const r = await fn();
            steps.push({ step: name, ok: !!r.ok, detail: JSON.stringify(r) });
        } catch (e) {
            steps.push({ step: name, ok: false, detail: String(e?.message ?? e) });
        }
    };
    await step(h, `
        S.set(model.projectFilterAtom, "all");
        S.set(model.liveOnlyAtom, false);
        S.set(model.backgroundedIdsAtom, new Set());
        S.set(model.railOpenAtom, true);
    `);

    await run("an asking card offers no Move to background", () =>
        step(h, `
            await setRoster(${JSON.stringify([asking("fx-off-ask"), working("fx-off-busy")])});
            const mute = (id) => card(id)?.querySelector('button[title^="Move to background"]') != null;
            const r = { askCard: card("fx-off-ask") != null, askMute: mute("fx-off-ask"), workingMute: mute("fx-off-busy") };
            r.ok = r.askCard && !r.askMute && r.workingMute;
            return r;
        `)
    );

    await run("a backgrounded agent that finishes leaves Backgrounded and shows on the grid", () =>
        step(h, `
            await setRoster(${JSON.stringify([working("fx-off-fin"), working("fx-off-other")])});
            S.set(model.backgroundedIdsAtom, new Set(["fx-off-fin"]));
            await nap(${SETTLE_MS});
            const before = { card: card("fx-off-fin") != null, section: header("Backgrounded") != null };
            // a just-finished agent, inside the grace window, so its card stays on the grid
            await setRoster(${JSON.stringify([idle("fx-off-fin", 0), working("fx-off-other")])}.map((a) =>
                a.state === "idle" ? { ...a, idleSince: Date.now() } : a));
            const after = {
                card: card("fx-off-fin") != null,
                section: header("Backgrounded") != null,
                inSet: S.get(model.backgroundedIdsAtom).has("fx-off-fin"),
            };
            return { before, after, ok: !before.card && before.section && after.card && !after.section && !after.inSet };
        `)
    );

    await run("a b press on a just-finished card does not land it in Backgrounded", () =>
        step(h, `
            const id = "fx-off-justfin";
            await setRoster([${JSON.stringify(idle("fx-off-justfin", 0))}, ${JSON.stringify(working("fx-off-other"))}].map((a) =>
                a.state === "idle" ? { ...a, idleSince: Date.now() } : a));
            S.set(model.cursorIdAtom, id);
            await nap(${SETTLE_MS});
            const cursorAtPress = S.get(model.cursorIdAtom);
            // a dispatched keydown reaches the surface's own React onKeyDown without CDP page focus
            surface().dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true }));
            // read synchronously, before the prune effect runs: proves the b press itself landed the id
            const addedByKey = S.get(model.backgroundedIdsAtom).has(id);
            await nap(${SETTLE_MS});
            const r = {
                cursorAtPress,
                addedByKey,
                card: card(id) != null,
                section: header("Backgrounded") != null,
                inSet: S.get(model.backgroundedIdsAtom).has(id),
            };
            r.ok = cursorAtPress === id && addedByKey && r.card && !r.section && !r.inSet;
            return r;
        `)
    );

    await run("a restored card returns to its old slot", () =>
        step(h, `
            await setRoster(${JSON.stringify(["fx-off-a", "fx-off-b", "fx-off-c"].map(working))});
            const before = cardIds();
            S.set(model.backgroundedIdsAtom, new Set(["fx-off-b"]));
            await nap(${SETTLE_MS});
            const hidden = card("fx-off-b") == null;
            header("Backgrounded")?.click();
            await nap(${SETTLE_MS});
            sectionRow("fx-off-b")?.click();
            await nap(${SETTLE_MS});
            const after = cardIds();
            return { before, hidden, after, ok: hidden && before.length === 3 && JSON.stringify(before) === JSON.stringify(after) };
        `)
    );

    await run("an Idle row reads its real idle age", () =>
        step(h, `
            await setRoster([${JSON.stringify(idle("fx-off-idle", 0))}].map((a) => ({ ...a, idleSince: Date.now() - ${OLD_IDLE_MS} })));
            if (!sectionRow("fx-off-idle")) header("Idle")?.click();
            await nap(${SETTLE_MS});
            // the age span alone: the project chip's text runs into it with no space
            const age = [...(sectionRow("fx-off-idle")?.querySelectorAll("span") ?? [])].pop();
            const r = { row: flat(sectionRow("fx-off-idle")), age: flat(age) };
            r.ok = r.age === "10m idle";
            return r;
        `)
    );

    await run("an Events row for a backgrounded agent restores and pulses its card", () =>
        step(h, `
            const id = "fx-off-evbg";
            await setRoster(${JSON.stringify([working("fx-off-evbg"), working("fx-off-other")])});
            // asked then answered: a real transition gives the agent its Events rows
            await setRoster(${JSON.stringify([asking("fx-off-evbg"), working("fx-off-other")])});
            await setRoster(${JSON.stringify([working("fx-off-evbg"), working("fx-off-other")])});
            S.set(model.backgroundedIdsAtom, new Set([id]));
            await nap(${SETTLE_MS});
            const before = { card: card(id) != null, row: railRow(id) != null };
            railRow(id)?.click();
            await until(() => card(id)?.className.includes("ring-warning"), 2000);
            const r = {
                before,
                inSet: S.get(model.backgroundedIdsAtom).has(id),
                card: card(id) != null,
                pulse: !!card(id)?.className.includes("ring-warning"),
                cursor: S.get(model.cursorIdAtom),
            };
            r.ok = !before.card && before.row && !r.inSet && r.card && r.pulse && r.cursor === id;
            return r;
        `)
    );

    await run("an Events row for a parked idle agent opens its terminal", () =>
        step(h, `
            const id = "fx-off-evidle";
            await setRoster(${JSON.stringify([working("fx-off-evidle")])});
            // working to a long-ago idle: a finished row, and the agent parks past the grace window
            await setRoster([${JSON.stringify(idle("fx-off-evidle", 0))}].map((a) => ({ ...a, idleSince: Date.now() - ${OLD_IDLE_MS} })));
            const before = { card: card(id) != null, row: railRow(id) != null };
            const opened = [];
            const orig = model.openTerminal;
            model.openTerminal = function (agentId) {
                opened.push(agentId);
                return orig.call(this, agentId);
            };
            try {
                railRow(id)?.click();
                await nap(${SETTLE_MS});
            } finally {
                model.openTerminal = orig;
            }
            const r = { before, opened, surface: S.get(model.surfaceAtom), focus: S.get(model.focusIdAtom) };
            r.ok = !before.card && before.row && opened.length === 1 && opened[0] === id && r.surface === "agent" && r.focus === id;
            return r;
        `)
    );

    await h.goto("cockpit");
    await h.shot("cdp-shots/cockpit-offgrid.png");
    return steps;
}

async function teardown(h, ctx) {
    if (ctx.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
    try {
        await step(h, `S.set(model.backgroundedIdsAtom, new Set());`);
    } catch {
        /* the reload below starts from the live roster either way */
    }
    await polishReload(h);
    await h.goto("cockpit");
}

export const cockpitOffgrid = {
    name: "cockpit-offgrid",
    surface: "cockpit",
    arrange,
    assert,
    teardown,
};
