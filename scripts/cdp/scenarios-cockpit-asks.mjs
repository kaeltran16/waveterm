// Cockpit review scenarios: ask keyboard answers.
// F6: a digit on a single-select question picks and moves to the next unanswered question, and Enter on a partial
// answer moves there too instead of opening the Agent surface. F3: only a pi ask, whose dismiss cancels it, shows the
// x. The fixture roster is read once at boot, so arrange writes it and reloads.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { MODELS_VIEWPORT, TREE_RAIL_FIXTURE, lookEval, polishReload, polishWaitFor } from "./scenarios-shared.mjs";

const CLAUDE_ID = "fx-ask-keys-claude";
const PI_ID = "fx-ask-keys-pi";
const Q1 = { header: "Scope", question: "Which scope should the fix cover?", options: [{ label: "this file" }, { label: "the package" }] };
const Q2 = { header: "Tests", question: "Which tests should prove it?", options: [{ label: "unit" }, { label: "scenario" }] };

const roster = () => [
    {
        id: CLAUDE_ID,
        name: "ask-keys claude",
        project: "ask-keys",
        task: "answer two questions",
        state: "asking",
        agent: "claude",
        model: "opus",
        blockedMs: 60_000,
        blockId: "fx-blk-ask-keys-claude",
        ask: { askId: "fx-ask-keys-claude-ask", oref: "block:fx-blk-ask-keys-claude", questions: [Q1, Q2] },
    },
    {
        id: PI_ID,
        name: "ask-keys pi",
        project: "ask-keys",
        task: "answer one question",
        state: "asking",
        agent: "pi",
        blockedMs: 30_000,
        blockId: "fx-blk-ask-keys-pi",
        ask: {
            askId: "fx-ask-keys-pi-ask",
            oref: "block:fx-blk-ask-keys-pi",
            questions: [{ header: "Go", question: "Ship it?", options: [{ label: "yes" }, { label: "no" }] }],
        },
    },
];

// the cockpit's model, found the way the other scenarios find it: on the nav rail's props
const MODEL = `(() => {
    const nav = document.querySelector('nav');
    const key = nav && Object.keys(nav).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? nav[key] : null; f != null; f = f.return) {
        if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
    }
    return null;
})()`;
const card = (id) => `document.querySelector('[data-cockpit-surface] [data-agent-id="${id}"]')`;
const DISMISS = `button[title^="Dismiss this question"]`;

// a key pressed on the cockpit with the Claude card under the cursor, then what the ask shows
const pressOnClaude = (h, key) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const model = ${MODEL};
        if (!model) return { error: "no cockpit model" };
        globalStore.set(model.cursorIdAtom, ${JSON.stringify(CLAUDE_ID)});
        await nap(200);
        const surface = document.querySelector('[data-cockpit-surface]');
        surface.focus();
        surface.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
        await nap(400);
        const c = ${card(CLAUDE_ID)};
        const sel = globalStore.get(model.answerSelAtom)[${JSON.stringify(CLAUDE_ID)}] ?? {};
        return {
            surface: globalStore.get(model.surfaceAtom),
            tab: globalStore.get(model.answerTabAtom)[${JSON.stringify(CLAUDE_ID)}] ?? 0,
            q1: [...(sel[0] ?? [])],
            q2: [...(sel[1] ?? [])],
            sent: globalStore.get(model.sentIdsAtom).has("fx-ask-keys-claude-ask"),
            // the active tab draws the asking accent's soft fill; the inactive one has none
            activeTab: flat([...(c?.querySelectorAll("button") ?? [])].find((b) => /bg-warning\\/15/.test(b.className) && /^(Scope|Tests)$/.test(flat(b)))),
            showsQ2Option: !!button(c, /^\\d?scenario$/),
        };
    `);

export const cockpitAskKeys = {
    name: "cockpit-ask-keys",
    surface: "cockpit",
    async arrange(h) {
        const ctx = {};
        try {
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(roster(), null, 2));
            ctx.wroteFixture = true;
            await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
            await polishReload(h);
            await h.goto("cockpit");
            const ready = await polishWaitFor(h, `!!${card(CLAUDE_ID)} && !!${card(PI_ID)}`, 10_000);
            if (!ready) ctx.arrangeError = "the fixture cards never rendered";
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) return [{ step: "cockpit-ask-keys: arrange", ok: false, detail: ctx.arrangeError }];
        const steps = [];

        const digit = await pressOnClaude(h, "1");
        steps.push({
            step: "digit 1 on question 1 moves the ask to question 2",
            ok: digit.tab === 1 && digit.q1.join() === "0" && digit.q2.length === 0 && digit.activeTab === "Tests" && digit.showsQ2Option && !digit.sent,
            detail: JSON.stringify(digit),
        });
        await h.shot("cdp-shots/cockpit-ask-keys-digit.png");

        const enter = await pressOnClaude(h, "Enter");
        steps.push({
            step: "Enter with question 2 unanswered stays on the Cockpit and shows question 2",
            ok: enter.surface === "cockpit" && enter.tab === 1 && enter.activeTab === "Tests" && enter.showsQ2Option && !enter.sent,
            detail: JSON.stringify(enter),
        });

        const dismiss = await h.ev(`({
            claude: !!${card(CLAUDE_ID)}?.querySelector('${DISMISS}'),
            pi: !!${card(PI_ID)}?.querySelector('${DISMISS}'),
        })`);
        steps.push({ step: "the Claude ask shows no dismiss ×", ok: dismiss.claude === false && !!ctx.wroteFixture, detail: JSON.stringify(dismiss) });
        steps.push({ step: "the pi ask shows its dismiss ×", ok: dismiss.pi === true, detail: JSON.stringify(dismiss) });
        await h.shot("cdp-shots/cockpit-ask-keys-dismiss.png");
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx?.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
        await h.cdp("Emulation.clearDeviceMetricsOverride");
        // onto the live roster again, with the fixture's answer state gone with the page
        await polishReload(h);
        await h.goto("cockpit");
    },
};
