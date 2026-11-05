// Agent review scenario `agent-keys` (F2, F7, F11, F12, F14 `d`): the focus keys walk the tree in its rendered
// order, booting and parked agents and terminals included; a Cockpit visit does not reorder the tree; a double
// Ctrl+C on a plain terminal opens no close confirm; a terminal has no `d` chip. The roster is a fixture: a pinned
// agent backed by a real tab with no controller (so its terminal mounts and nothing runs), an agent idle past the
// grace window and a booting one, plus one real plain terminal tab. Keys are dispatched as keydown events from page
// JS: CDP Input.dispatchKeyEvent often never reaches the WebView.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { agentPage, closeTabs, makeTab, restoreRoster, setRoster } from "./agent-page-fixtures.mjs";

const NAME = "agent-keys";
const PROJECT = "arc-verify-keys";
const HOUR_MS = 3_600_000;
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;

// the tree's focusable rows, top to bottom, as rendered
const TREE_ORDER = `[...document.querySelectorAll("[data-agent-tree] [data-tree-agent], [data-agent-tree] [data-tree-terminal]")]
    .map((el) => el.dataset.treeAgent ?? el.dataset.treeTerminal)`;

// key presses land on the surface wrapper, which is not editable, so the agent keys are live
const press = (h, keys) =>
    agentPage(
        h,
        `const model = agentsModel();
        const wrap = document.querySelector("[data-cockpit-surface-wrap]");
        const seen = [];
        for (const k of ${JSON.stringify(keys)}) {
            wrap.focus();
            wrap.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...k }));
            await nap(80);
            seen.push(globalStore.get(model.focusIdAtom));
        }
        return seen;`
    );

const setFocus = (h, id) =>
    agentPage(
        h,
        `const model = agentsModel();
        globalStore.set(model.focusIdAtom, ${JSON.stringify(id)});
        await nap(250);
        document.querySelector("[data-cockpit-surface-wrap]")?.focus();
        await nap(250);
        return globalStore.get(model.focusIdAtom);`
    );

// the footer's chips as [glyph, label]
const CHIPS = `[...(document.querySelector("[data-footer-chips]")?.children ?? [])].map((c) => [
        (c.children[0]?.textContent ?? "").trim(),
        (c.textContent ?? "").replace(c.children[0]?.textContent ?? "", "").trim(),
    ])`;
const chips = (h) => h.ev(CHIPS);

// the chips at rest, focus on the surface wrapper: in a terminal the footer hides the agent keys whatever row is
// focused, and a terminal row's xterm can take focus once it mounts, so the wrapper takes it back
const restChips = (h) =>
    agentPage(
        h,
        `const wrap = document.querySelector("[data-cockpit-surface-wrap]");
        let atRest = false;
        for (let i = 0; i < 5 && !atRest; i++) {
            wrap.focus();
            await nap(200);
            atRest = document.activeElement === wrap;
        }
        // the footer recomputes on focus events, and can miss focus leaving a terminal's xterm (it keeps showing its
        // in-terminal posture with the wrapper focused), so one is sent once focus is at rest
        window.dispatchEvent(new FocusEvent("focusin"));
        await nap(200);
        return { atRest, chips: ${CHIPS} };`
    );

// two Ctrl+C presses, well within the double-press window, inside the focused session's terminal
const doubleCtrlC = (h, id) =>
    agentPage(
        h,
        `const { modalsModel } = await mod("app/store/modalmodel.ts");
        const ta = await (async () => {
            let el = null;
            await until(() => (el = document.querySelector('[data-agent-terminal="${id}"] .xterm-helper-textarea')) != null);
            return el;
        })();
        if (ta == null) return { error: "no terminal for ${id}" };
        ta.focus();
        const before = globalStore.get(modalsModel.modalsAtom).length;
        for (let i = 0; i < 2; i++) {
            ta.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true }));
            await nap(60);
        }
        await nap(200);
        const added = globalStore.get(modalsModel.modalsAtom).slice(before);
        return { added: added.map((m) => ({ name: m.displayName, title: m.props?.title })) };`
    );

const cancelModals = (h) =>
    agentPage(
        h,
        `const { modalsModel } = await mod("app/store/modalmodel.ts");
        while (modalsModel.hasOpenModals()) modalsModel.popModal();
        return true;`
    );

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const tag = randomUUID().slice(0, 8);
                const ctx = {};
                await h.goto("agent");
                // a throw past this point still returns ctx, so teardown closes whatever was already made
                try {
                    const pinned = await makeTab(h, ctx, { label: `keys-pinned-${tag}` });
                    const term = await makeTab(h, ctx, {
                        label: `keys-term-${tag}`,
                        // a sidebar row is a terminal only once its term block has a cwd; still no controller
                        blockMeta: { view: "term", "cmd:cwd": tmpdir() },
                        tabMeta: { "session:agent": "terminal" },
                    });
                    ctx.pinnedId = pinned.tabId;
                    ctx.idleId = `arc-verify-keys-idle-${tag}`;
                    ctx.bootingId = `arc-verify-keys-booting-${tag}`;
                    ctx.termId = term.tabId;
                    const now = Date.now();
                    // roster order idle, booting, pinned: the tree lifts the pinned one first
                    await setRoster(h, [
                        {
                            id: ctx.idleId,
                            name: `keys-idle-${tag}`,
                            task: "",
                            state: "idle",
                            project: PROJECT,
                            idleSince: now - HOUR_MS,
                        },
                        {
                            id: ctx.bootingId,
                            name: `keys-booting-${tag}`,
                            task: "",
                            state: "working",
                            project: PROJECT,
                            booting: true,
                        },
                        {
                            id: ctx.pinnedId,
                            name: `keys-pinned-${tag}`,
                            task: "",
                            state: "working",
                            project: PROJECT,
                            pinned: true,
                            blockId: pinned.blockId,
                            activeMs: 60_000,
                        },
                    ]);
                    const shown = await agentPage(
                        h,
                        `return until(() => {
                            const ids = ${TREE_ORDER};
                            return ${JSON.stringify([ctx.idleId, ctx.bootingId, ctx.pinnedId, ctx.termId])}.every((id) => ids.includes(id));
                        }, 10000);`
                    );
                    if (!shown) {
                        const seen = await agentPage(
                            h,
                            `const model = agentsModel();
                            return { tree: ${TREE_ORDER}, surface: globalStore.get(model.surfaceAtom),
                                agents: globalStore.get(model.agentsAtom).map((a) => a.id),
                                terminals: globalStore.get(model.terminalsAtom).map((t) => t.id) };`
                        );
                        throw new Error(`the fixture rows did not all reach the tree: ${JSON.stringify({ ctx, seen })}`);
                    }
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the fixture roster and tabs", false, ctx.arrangeError);
                    return steps;
                }
                const rows = await h.ev(TREE_ORDER);
                const n = rows.length;
                const back = [...rows].reverse();
                const walk = async (next, prev) => {
                    await setFocus(h, rows[0]);
                    const down = [rows[0], ...(await press(h, Array(n - 1).fill(next)))];
                    const up = [rows[n - 1], ...(await press(h, Array(n - 1).fill(prev)))];
                    return { down, up };
                };
                const fixtureOrder = [ctx.pinnedId, ctx.idleId, ctx.bootingId];

                // 1. j / k
                const jk = await walk({ key: "j", code: "KeyJ" }, { key: "k", code: "KeyK" });
                const agentsFirst = same(
                    rows.filter((id) => fixtureOrder.includes(id)),
                    fixtureOrder
                );
                await h.shot(SHOT(1, "jk"));
                rec(
                    "1. j from the first row visits every tree row in its rendered order (pinned, idle, booting, terminal); k walks back",
                    agentsFirst && rows.includes(ctx.termId) && same(jk.down, rows) && same(jk.up, back),
                    JSON.stringify({ rows, down: jk.down, up: jk.up })
                );

                // 2. ↓ / ↑, and the footer's move chip
                const arrows = await walk({ key: "ArrowDown", code: "ArrowDown" }, { key: "ArrowUp", code: "ArrowUp" });
                const footer = await chips(h);
                await h.shot(SHOT(2, "arrows"));
                rec(
                    "2. ↓ / ↑ walk the tree like j / k, and the footer shows the ↑↓ move chip",
                    same(arrows.down, rows) &&
                        same(arrows.up, back) &&
                        footer.some(([g, l]) => g === "↑↓" && l === "move"),
                    JSON.stringify({ down: arrows.down, up: arrows.up, footer })
                );

                // 3. Ctrl+Tab wraps from the last row to the first; Ctrl+Shift+Tab goes backward
                await setFocus(h, rows[n - 1]);
                const tab = { key: "Tab", code: "Tab", ctrlKey: true };
                const fwd = await press(h, [tab]);
                const bwd = await press(h, [
                    { ...tab, shiftKey: true },
                    { ...tab, shiftKey: true },
                ]);
                // terminals list below the agents, so the last row is one
                const lastIsTerminal = await h.ev(
                    `document.querySelector('[data-agent-tree] [data-tree-terminal="${rows[n - 1]}"]') != null`
                );
                await h.shot(SHOT(3, "ctrl-tab"));
                rec(
                    "3. Ctrl+Tab wraps from the terminal (last row) to the first; Ctrl+Shift+Tab goes backward",
                    lastIsTerminal && same(fwd, [rows[0]]) && same(bwd, [rows[n - 1], rows[n - 2]]),
                    JSON.stringify({ from: rows[n - 1], fwd, bwd })
                );

                // 4. a Cockpit visit parks the idle agent; the tree keeps its order
                await h.goto("cockpit");
                const cockpitOrder = await agentPage(h, `return globalStore.get(agentsModel().orderAtom);`);
                await h.goto("agent");
                const after = await h.ev(TREE_ORDER);
                await h.shot(SHOT(4, "after-cockpit"));
                rec(
                    "4. a Cockpit visit that parks the idle agent leaves the tree order unchanged on return",
                    same(after, rows),
                    JSON.stringify({ before: rows, after, cockpitOrder })
                );

                // 5. double Ctrl+C: no confirm on the terminal, the close confirm on an agent
                await setFocus(h, ctx.termId);
                const onTerm = await doubleCtrlC(h, ctx.termId);
                await h.shot(SHOT(5, "ctrl-c-terminal"));
                await setFocus(h, ctx.pinnedId);
                const onAgent = await doubleCtrlC(h, ctx.pinnedId);
                await h.shot(SHOT(5, "ctrl-c-agent"));
                await cancelModals(h);
                rec(
                    "5. two Ctrl+C presses on the plain terminal open no close confirm; on an agent they do (cancelled)",
                    onTerm.added?.length === 0 &&
                        onAgent.added?.length === 1 &&
                        onAgent.added[0].name === "ConfirmModal" &&
                        onAgent.added[0].title === "Close agent",
                    JSON.stringify({ onTerm, onAgent })
                );

                // 6. the d chip: none for a terminal, there for an agent
                await setFocus(h, ctx.termId);
                const termChips = await restChips(h);
                await h.shot(SHOT(6, "terminal-footer"));
                await setFocus(h, ctx.pinnedId);
                const agentChips = await restChips(h);
                await h.shot(SHOT(6, "agent-footer"));
                const has = (r, glyph) => r.chips.some(([g]) => g === glyph);
                // the move chip shows the footer is at rest, where the agent keys are live
                rec(
                    "6. with the terminal focused the footer has no d chip; with an agent focused it has",
                    termChips.atRest &&
                        agentChips.atRest &&
                        has(termChips, "↑↓") &&
                        !has(termChips, "d") &&
                        has(agentChips, "d"),
                    JSON.stringify({ termChips, agentChips })
                );
                return steps;
            },
            async teardown(h, ctx) {
                try {
                    await cancelModals(h);
                } catch (e) {
                    console.error(`${NAME}: closing modals failed: ${e?.message ?? e}`);
                }
                await restoreRoster(h);
                await closeTabs(h, ctx);
            },
        },
    ];
}
