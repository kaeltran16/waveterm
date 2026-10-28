// Brainstorm scenarios, and BS_KIT, the helpers the scenarios-brainstorm-*.mjs modules are handed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    BS_ANSWER_LINES,
    BS_BOARDS,
    BS_BUILDER_A,
    BS_BUILDER_Q,
    BS_CHECK,
    BS_HANDOFF,
    BS_HANDOFF_ANSWERED,
    BS_HANDOFF_PARTS,
    BS_HISTORY,
    BS_HISTORY_Q4,
    BS_PANE,
    BS_PART,
    BS_POLL_WAIT_MS,
    BS_Q1,
    BS_Q2_OPTIONS,
    BS_Q4,
    BS_Q4_OPTIONS,
    BS_SPEC,
    BS_SWITCH,
    BS_TOPIC,
    NEW_RUN,
    PEEKS_ESC,
    RUN_SHEET_POLISH_TASKS,
    UI_ROUTE,
    arrangeSheetDagRun,
    bsClick,
    bsFile,
    bsParts,
    bsPublishStatus,
    bsReveal,
    bsShowPane,
    flatText,
    fstShow,
    fstWriteRun,
    openCanvasTerminal,
    polishNap,
    polishReload,
    polishWaitFor,
    pressCanvasKey,
    seedDag,
    seedFinalShots,
    skipStep,
    teardownFixtureRun,
    waitForProjectInConfig,
    waveService,
} from "./scenarios-shared.mjs";

// a second topic revealed from the same terminal, whose file never parses
// --- brainstorm mode: an agent's brainstorm.json drawn beside its terminal, every action one line sent to it -----
// (docs/superpowers/specs/2026-10-18-brainstorm-mode-design.md). The terminal is opened as canvas-swap opens its own
// and made a roster agent by publishing the agent:status `wsh agentstatus` would. Each step writes that step's
// brainstorm.json, the agent's side of the protocol, and waits for the poller to draw it. A sent line is read
// twice: from the page's own agentprompt calls, which say exactly what was sent, and from the terminal's
// scrollback, which says it reached the shell (a session with no mod has it typed, and the shell runs each one as
// a failing command). A sent line reads as the agent writing until the agent takes it, so between two sends
// bsAgentTook plays the agent ending its turn.
const BS_UNREADABLE_TOPIC = "lag-alerts-unreadable";
const BS_RUN = "7f3a21c0-4d1e-4b6a-9c2f-1e8d7a6b5c40";
const BS_TREE_LINE = `document.querySelector("[data-brainstorm-tree-line]")`;
const BS_EDIT = `document.querySelector("[data-brainstorm-pane] [data-brainstorm-edit]")`;
const BS_ANSWER = `document.querySelector("[data-brainstorm-pane] [data-brainstorm-answer]")`;
const BS_BUILDER_ANSWER = `document.querySelector("[data-brainstorm-builder-question] textarea")`;
const BS_APPROVE_BAR = `document.querySelector("[data-brainstorm-approve-bar]")`;
const BS_QUESTION_CARD = `document.querySelector("[data-brainstorm-question]")`;
const BS_CONFIRM_ALL = `document.querySelector("[data-brainstorm-pane] [data-brainstorm-confirm-all]")`;
const BS_POPUP_CARD = `document.querySelector("button[data-attention-popup]")`;
const bsPartSel = (id) => `document.querySelector('[data-brainstorm-pane] [data-brainstorm-part="${id}"]')`;
// the attach lands between ticks, then two failed reads in a row
const BS_ERROR_WAIT_MS = 10000;
const BS_TYPED_WAIT_MS = 5000;
const BS_ROSTER_WAIT_MS = 10000;
const BS_NOTHING_TYPED_MS = 800;
const BS_SCROLLBACK_LINES = 400;
// the shell's prompt ends its last row: pwsh and cmd end in >, bash and zsh in $, # or %
const BS_PROMPT = /[>$#%]$/;
const BS_PROMPT_WAIT_MS = 20000;
const BS_SHIFT = 8;
const BS_CTRL_SHIFT = 2 | 8;
const BS_B_KEY = { key: "b", code: "KeyB", keyCode: 66 };
const BS_KEY_DEF = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
};
const BS_ADDED = "The recording rules need Prometheus 2.45 or later for the new lag functions; staging runs 2.41.";
const BS_WHY = "your answer 4 named the lag growth rate, which needs those functions.";
const BS_Q5 = { n: 5, text: "If on-call could read only one number in the page, which would it be?", part: "page" };
// the same part asked between its two mockups: the question shows them beside the answers
const BS_Q5_LAYOUT = {
    n: 5,
    text: "Which layout should the page use?",
    part: "page",
    options: [
        { label: "Lag first", detail: "The lag number leads; the trend and the stuck partitions sit under it.", pick: true },
        { label: "Trend first", detail: "The trend chart leads; the number sits in its corner." },
    ],
};
const BS_EDITED = "Alerts go through the existing Alertmanager only. No new service.";
// a question about no part, asked after the builder check: the agent needs a choice before it can go on
const BS_SIDE_Q = { n: 6, text: "The spec names two Prometheus versions. Should I settle on 2.45 before you approve?" };
const BS_SIDE_A = "Yes, 2.45.";
const BS_MID_STATES = {
    intent: "yours",
    goals: "yours",
    anti: "yours",
    current: "guess",
    constraints: "guess",
    thresholds: "asked",
    page: "guess",
    builder: "open",
};
// five yours, two guesses, one open: the compaction and exited boards' counts
const BS_LATE_STATES = { ...BS_MID_STATES, current: "yours", constraints: "yours", thresholds: "guess" };
const BS_ASKED = { thresholds: { body: "" } };
const BS_FILES = {
    justStarted: bsFile({ question: BS_Q1, parts: bsParts({ intent: "asked" }, { intent: { body: "" } }) }),
    mid: bsFile({ question: BS_Q4, parts: bsParts(BS_MID_STATES, BS_ASKED), history: BS_HISTORY }),
    answered: bsFile({
        question: BS_Q5,
        parts: bsParts({ ...BS_MID_STATES, thresholds: "guess" }),
        history: BS_HISTORY_Q4,
    }),
    working: bsFile({
        working: "Writing “When it pages” from your answer.",
        parts: bsParts(BS_MID_STATES, BS_ASKED),
        history: BS_HISTORY_Q4,
    }),
    changed: bsFile({
        question: BS_Q5,
        parts: bsParts(
            { ...BS_MID_STATES, current: "yours", thresholds: "guess" },
            { constraints: { body: `${BS_PART.constraints.body} ${BS_ADDED}`, was: BS_PART.constraints.body, why: BS_WHY } }
        ),
        history: BS_HISTORY_Q4,
    }),
    late: bsFile({ question: BS_Q5, parts: bsParts(BS_LATE_STATES), history: BS_HISTORY_Q4 }),
    layout: bsFile({
        question: BS_Q5_LAYOUT,
        parts: bsParts({ ...BS_MID_STATES, thresholds: "guess" }),
        history: BS_HISTORY_Q4,
    }),
    lateWorking: bsFile({
        working: "Writing “What on-call sees” from your answer.",
        parts: bsParts(BS_LATE_STATES),
        history: BS_HISTORY_Q4,
    }),
};
// the touched parts in the file's order, which is the order the check draws them in
const BS_TOUCHED_ORDER = ["intent", "anti", "thresholds", "builder"];
// every part yours and the agent done, before the builder check: the Ready board
const BS_READY = bsFile({ done: true, parts: BS_HANDOFF_PARTS, history: BS_HISTORY_Q4 });

function bsWrite(ctx, file) {
    writeFileSync(ctx.file, typeof file === "string" ? file : JSON.stringify(file, null, 2));
}

// everything a step judges on the Agent surface, in one read. innerText, so text in sibling elements reads apart
const bsRead = (h, ctx) =>
    h.ev(`(() => {
        const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
        const pane = ${BS_PANE};
        const sw = ${BS_SWITCH};
        const term = document.querySelector('[data-agent-terminal="${ctx.tabId}"]');
        const btn = (el) => (el ? { disabled: el.disabled, title: el.title } : null);
        const btns = (label) =>
            [...(pane?.querySelectorAll("button") ?? [])].filter((b) => flat(b) === label).map(btn);
        return {
            view: pane?.getAttribute("data-brainstorm-view") ?? null,
            text: flat(pane),
            toolbar: flat(pane?.firstElementChild),
            phase: flat(pane?.querySelector('[data-brainstorm-phase] [aria-current="step"]')),
            progress: flat(pane?.querySelector("[data-brainstorm-progress]")),
            segments: [...(pane?.querySelectorAll("[data-brainstorm-progress] [data-state]") ?? [])].map((x) =>
                x.getAttribute("data-state")
            ),
            title: flat(pane?.querySelector("h1")),
            reviewShown: !!pane?.querySelector("[data-brainstorm-review]"),
            review: flat(pane?.querySelector("[data-brainstorm-review-line]")),
            skipNote: flat(pane?.querySelector("[data-brainstorm-skip-note]")),
            workingNote: flat(pane?.querySelector("[data-brainstorm-working-note]")),
            tiles: [...(pane?.querySelectorAll("[data-brainstorm-tile]") ?? [])].map(flat),
            approveReason: flat(pane?.querySelector("[data-brainstorm-approve-reason]")),
            question: flat(pane?.querySelector("[data-brainstorm-question]")),
            answerBox: !!pane?.querySelector("[data-brainstorm-answer]"),
            lineBox: pane?.querySelector("[data-brainstorm-line-box]")?.getAttribute("data-brainstorm-line-box") ?? null,
            working: flat(pane?.querySelector("[data-brainstorm-working]")),
            stale: flat(pane?.querySelector("[data-brainstorm-stale]")),
            check: btn(pane?.querySelector("[data-brainstorm-check-btn]")),
            approve: btn(pane?.querySelector("[data-brainstorm-approve]")),
            approveBar: flat(pane?.querySelector("[data-brainstorm-approve-bar]")),
            builder: flat(pane?.querySelector("[data-brainstorm-builder-question]")),
            exited: flat(pane?.querySelector("[data-brainstorm-exited]")),
            resume: !!pane?.querySelector("[data-brainstorm-resume]"),
            parts: [...(pane?.querySelectorAll("[data-brainstorm-part]") ?? [])].map((p) => ({
                id: p.getAttribute("data-brainstorm-part"),
                state: p.getAttribute("data-state"),
                text: flat(p),
                calls: [...p.querySelectorAll("span")].filter((s) => flat(s.firstElementChild) === "Agent’s call").length,
            })),
            history: [...(pane?.querySelectorAll("[data-brainstorm-history] > div") ?? [])].map((r) => ({
                label: flat(r.querySelector("span")),
                text: flat(r),
                picked: [...r.querySelectorAll("li[data-picked]")].map(flat),
                unpicked: [...r.querySelectorAll("li:not([data-picked])")].map(flat),
            })),
            rail: flat(pane?.querySelector("[data-brainstorm-rail] h2")),
            railText: flat(pane?.querySelector("[data-brainstorm-rail]")),
            why: flat(pane?.querySelector("[data-brainstorm-why]")),
            // the asked part's mockups in the question view: each thumbnail, its label, and whether it sits right of the answers
            qBoards: [...(pane?.querySelectorAll("[data-brainstorm-question] [data-brainstorm-thumb]") ?? [])].map((t) => {
                const answers = pane.querySelector("[data-brainstorm-question-boards] [data-brainstorm-option]")?.parentElement;
                return {
                    name: t.getAttribute("data-brainstorm-thumb"),
                    frame: !!t.querySelector("iframe"),
                    label: flat(t.nextElementSibling?.firstElementChild),
                    open: flat(t.nextElementSibling?.querySelector("[data-brainstorm-open-board]")),
                    besideAnswers: answers ? answers.getBoundingClientRect().right <= t.getBoundingClientRect().left : null,
                };
            }),
            options: [...(pane?.querySelectorAll("[data-brainstorm-option]") ?? [])].map((o) => ({
                text: flat(o),
                pick: o.hasAttribute("data-pick"),
            })),
            track: [...(pane?.querySelectorAll("[data-brainstorm-track] [data-state]") ?? [])].map((x) =>
                x.getAttribute("data-state")
            ),
            designBtn: flat(pane?.querySelector("[data-brainstorm-design-btn]")),
            back: flat(pane?.querySelector("[data-brainstorm-back]")),
            placeholder: pane?.querySelector("[data-brainstorm-answer]")?.getAttribute("placeholder") ?? null,
            okBtn: btn(pane?.querySelector("[data-brainstorm-ok]")),
            confirm: btns("That’s right"),
            guessFor: btns("Guess for me").length,
            switch: sw
                ? [...sw.querySelectorAll("button")].map((b) => ({ label: flat(b), pressed: b.getAttribute("aria-pressed") }))
                : null,
            hint: flat(document.querySelector("[data-footer-chips]")),
            compacted: flat(document.querySelector("[data-brainstorm-compacted]")),
            terminal: term ? !term.classList.contains("hidden") : null,
            treeLine: flat(${BS_TREE_LINE}),
        };
    })()`);

// polls the surface until want(read) holds; the last read, whether it did, and the wait
async function bsUntil(h, ctx, want, ms = BS_POLL_WAIT_MS) {
    const start = Date.now();
    let s;
    do {
        s = await bsRead(h, ctx).catch((e) => ({ error: String(e?.message ?? e), parts: [], history: [] }));
        if (s.error == null && want(s)) return { ...s, ok: true, ms: Date.now() - start };
        await polishNap(250);
    } while (Date.now() - start < ms);
    return { ...s, ok: false, ms: Date.now() - start };
}

const bsStates = (s) => Object.fromEntries((s?.parts ?? []).map((p) => [p.id, p.state]));
const bsPart = (s, id) => s?.parts?.find((p) => p.id === id);
const bsBrief = (s) => ({ ok: s.ok, ms: s.ms, view: s.view, error: s.error, text: (s.text ?? "").slice(0, 300) });

// a real click, which puts the page in focus: CDP key and text input reach nothing without it
async function bsMouseClick(h, elExpr) {
    const box = await h.ev(`(() => {
        const el = ${elExpr};
        el?.scrollIntoView({ block: "center" });
        const r = el?.getBoundingClientRect();
        return r && r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
    })()`);
    if (!box) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    return true;
}

// Shift is bound nowhere, so the probe seeing it proves key events reach the page
async function bsKeysArrive(h) {
    await h.ev(`(() => {
        window.__bsSeen = [];
        window.__bsProbe = (e) => window.__bsSeen.push(e.key);
        window.addEventListener("keydown", window.__bsProbe, true);
        return true;
    })()`);
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: BS_SHIFT });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
    await polishNap(200);
    const seen = await h.ev(`window.__bsSeen.includes("Shift")`);
    await h.ev(`window.removeEventListener("keydown", window.__bsProbe, true)`);
    return seen === true;
}

// React's change path, for when CDP text input does not reach the page
const bsSetValue = (elExpr, value) => `(() => {
    const el = ${elExpr};
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
})()`;

// types into a textarea the way a user does; "set" when the text had to go through bsSetValue instead
async function bsFill(h, elExpr, text) {
    await bsMouseClick(h, elExpr);
    await h.ev(bsSetValue(elExpr, ""));
    await h.cdp("Input.insertText", { text });
    if ((await h.ev(`${elExpr}?.value ?? null`)) === text) return "keys";
    await h.ev(bsSetValue(elExpr, text));
    return "set";
}

// a key in the focused textarea; without CDP input the keydown is dispatched on the element, which reaches React's
// handler but not the browser's own action
async function bsKey(h, elExpr, name, via, shift = false) {
    const { text, ...def } = BS_KEY_DEF[name];
    const modifiers = shift ? BS_SHIFT : 0;
    if (via === "keys") {
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...def, ...(text ? { text } : {}) });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...def });
    } else {
        await h.ev(
            `${elExpr}?.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(def.key)}, code: ${JSON.stringify(def.code)}, shiftKey: ${shift}, bubbles: true, cancelable: true }))`
        );
    }
    await polishNap(300);
}

// Esc as the user presses it, from the page's focus; a keydown on the document when CDP keys do not reach the page,
// which the dispatcher's window capture still takes
async function bsEscape(h) {
    if (await bsKeysArrive(h)) {
        await bsKey(h, null, "Escape", "keys");
        return "keys";
    }
    await h.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }))`);
    await polishNap(300);
    return "event";
}

// records every line the page sends an agent. Typing into the terminal (controllerinput) is not a send: the xterm
// reports its own focus in and out (ESC [I, ESC [O) through it
const BS_TYPED_INSTALL = `(() => {
    const c = window.TabRpcClient;
    if (!c) return false;
    if (c.__bsOrig) return true;
    c.__bsOrig = c.wshRpcCall;
    const call = c.wshRpcCall.bind(c);
    window.__bsTyped = [];
    c.wshRpcCall = (command, data, opts) => {
        if (command === "agentprompt") window.__bsTyped.push({ block: data?.blockid, text: data?.text });
        return call(command, data, opts);
    };
    return true;
})()`;
const BS_TYPED_REMOVE = `(() => {
    const c = window.TabRpcClient;
    if (c?.__bsOrig) {
        c.wshRpcCall = c.__bsOrig;
        delete c.__bsOrig;
    }
    return true;
})()`;

async function bsTermText(h, ctx, sep = "") {
    const r = await h.rpc(
        "termgetscrollbacklines",
        { linestart: 0, lineend: BS_SCROLLBACK_LINES, lastcommand: false },
        { route: `feblock:${ctx.blockId}`, timeout: 5000 }
    );
    return (r?.lines ?? []).join(sep);
}

// the shell's pty can break a long row with a hard newline, so rows are compared with every space dropped
const bsSquash = (s) => s.replace(/\s+/g, "");
const bsCount = (hay, line) => bsSquash(hay).split(bsSquash(line)).length - 1;

async function bsMark(h, ctx, line) {
    const typed = await h.ev(`(window.__bsTyped ?? []).length`);
    const shown = line == null ? 0 : bsCount(await bsTermText(h, ctx).catch(() => ""), line);
    return { typed, shown };
}

const bsSentSince = (h, mark) => h.ev(`(window.__bsTyped ?? []).slice(${mark.typed})`);

// what an action sent since `mark`: exactly the line, to the agent's block, once, and the terminal shows it
async function bsTyped(h, ctx, mark, line) {
    let sent = [];
    for (let waited = 0; waited < BS_TYPED_WAIT_MS && sent.length === 0; waited += 250) {
        sent = await bsSentSince(h, mark);
        if (sent.length === 0) await polishNap(250);
    }
    let shown = mark.shown;
    let termError = null;
    for (let waited = 0; waited < BS_TYPED_WAIT_MS && shown <= mark.shown; waited += 250) {
        try {
            shown = bsCount(await bsTermText(h, ctx), line);
        } catch (e) {
            termError = String(e?.message ?? e);
        }
        if (shown <= mark.shown) await polishNap(250);
    }
    sent = await bsSentSince(h, mark);
    const ok = sent.length === 1 && sent[0].block === ctx.blockId && sent[0].text === line && shown > mark.shown;
    return { ok, detail: { want: line, sent, inTerminal: shown > mark.shown, termError } };
}

async function bsNothingTyped(h, mark) {
    await polishNap(BS_NOTHING_TYPED_MS);
    const sent = await bsSentSince(h, mark);
    return { ok: sent.length === 0, sent };
}

// carries no version, so the terminal's own status (term-model.ts) ignores it; only the agent's exit signal reads it
const bsPublishProc = (h, ctx, status, code) =>
    h.rpc("eventpublish", {
        event: "controllerstatus",
        scopes: [`block:${ctx.blockId}`],
        data: { blockid: ctx.blockId, shellprocstatus: status, shellprocexitcode: code },
    });

// nothing reads as the agent writing: no working card, no working note, approve not held for it
const BS_NOT_WRITING = `(() => {
    const pane = document.querySelector("[data-brainstorm-pane]");
    return !!pane && !pane.querySelector("[data-brainstorm-working]") && !pane.querySelector("[data-brainstorm-working-note]") &&
        !(pane.querySelector("[data-brainstorm-approve-reason]")?.textContent ?? "").includes("writing");
})()`;

// the agent took the last sent line and ended its turn without a write: idle since now, which settles the line
async function bsAgentTook(h, ctx) {
    await bsPublishStatus(h, ctx);
    return polishWaitFor(h, BS_NOT_WRITING, BS_POLL_WAIT_MS);
}

const bsTabMeta = async (h, ctx) =>
    (await waveService(h, "object", "GetObject", [`tab:${ctx.tabId}`]))?.meta?.["session:brainstorm"] ?? null;

// the design sits behind its button while the pane asks or the agent writes; Back returns to the question
async function bsOpenDesign(h) {
    await h.ev(`${BS_PANE}?.querySelector("[data-brainstorm-design-btn]")?.click()`);
    return polishWaitFor(h, `!!${BS_PANE}?.querySelector("[data-brainstorm-back]")`, 3000);
}

async function bsCloseDesign(h) {
    await h.ev(`${BS_PANE}?.querySelector("[data-brainstorm-back]")?.click()`);
    return polishWaitFor(h, `!${BS_PANE}?.querySelector("[data-brainstorm-back]")`, 3000);
}

// the agent's row in the tree: the nearest ancestor of its brainstorm line that holds the status dot
const BS_ROW = `(() => {
    let row = ${BS_TREE_LINE};
    while (row && !row.querySelector("span.rounded-full[style]")) row = row.parentElement;
    return row;
})()`;
const BS_ROW_READ = `(() => {
    const row = ${BS_ROW};
    const dot = row?.querySelector("span.rounded-full[style]");
    return {
        name: (row?.querySelector(".font-medium")?.textContent ?? "").trim(),
        dotStyle: dot?.getAttribute("style") ?? null,
        dotPulse: dot?.classList.contains("pulse-dot") ?? null,
    };
})()`;

// the popup's card: its label and text are its unmarked children, in that order
const BS_POPUP_READ = `(async () => {
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const card = ${BS_POPUP_CARD};
    const plain = card
        ? [...card.children].filter((c) => ![...c.attributes].some((a) => a.name.startsWith("data-attention-popup")))
        : [];
    return {
        card: card != null,
        visible: await window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "attention-popup" }),
        label: flat(plain[0]),
        text: flat(plain[1]),
        detail: flat(card?.querySelector("[data-attention-popup-detail]")),
    };
})()`;

export const brainstormMode = {
    name: "brainstorm-mode",
    surface: "agent",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-brainstorm-"));
        const ctx = { cwd, file: join(cwd, ".superpowers", "brainstorm", BS_TOPIC, "brainstorm.json") };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            // the New run window approve opens needs a registered project; the agent's project label names it
            await h.rpc("createproject", { name: BS_TOPIC, path: cwd });
            ctx.project = BS_TOPIC;
            await waitForProjectInConfig(h, BS_TOPIC);
            await polishReload(h);
            mkdirSync(dirname(ctx.file), { recursive: true });
            const project = join(cwd, ".superpowers", "design", BS_TOPIC, "project");
            mkdirSync(project, { recursive: true });
            writeFileSync(
                join(project, "canvas.json"),
                JSON.stringify({ boards: Object.fromEntries(BS_BOARDS.map((b) => [b, { w: 1440 }])), order: BS_BOARDS })
            );
            for (const b of BS_BOARDS) {
                writeFileSync(join(project, b), `<!doctype html><title>${b}</title><h1 style="font:64px sans-serif">${b}</h1>`);
            }
            bsWrite(ctx, BS_FILES.justStarted);
            await openCanvasTerminal(h, ctx, BS_TOPIC);
            await bsPublishStatus(h, ctx);
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
            return ctx;
        }
        await h.goto("agent");
        // an agent row, not a terminal row: the tree line draws only on agent rows
        ctx.inRoster = await polishWaitFor(
            h,
            `!!document.querySelector('[data-agent-terminal="${ctx.tabId}"]') && !document.querySelector('[data-tree-terminal="${ctx.tabId}"]')`,
            BS_ROSTER_WAIT_MS
        );
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("brainstorm mode", `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        const TERM = `document.querySelector('[data-agent-terminal="${ctx.tabId}"]')`;
        // a line typed before the shell's first prompt can be lost, and the terminal is where typed lines are read
        let prompt = "";
        for (const start = Date.now(); ctx.inRoster && Date.now() - start < BS_PROMPT_WAIT_MS; await polishNap(250)) {
            const rows = (await bsTermText(h, ctx, "\n").catch(() => "")).split("\n").filter((r) => r.trim() !== "");
            prompt = rows.at(-1)?.trim() ?? "";
            if (BS_PROMPT.test(prompt)) break;
        }
        rec(
            "0. the terminal is a roster agent at its shell's prompt",
            ctx.inRoster === true && BS_PROMPT.test(prompt),
            { tab: ctx.tabId, inRoster: ctx.inRoster, lastRow: prompt }
        );
        if (!ctx.inRoster) return steps;
        await h.ev(BS_TYPED_INSTALL);
        // tagged before any switch: a remount would drop the attribute with the node
        const tagged = await h.ev(`(() => {
            const t = ${TERM};
            t.setAttribute("data-verify-mark", "brainstorm-mode");
            const x = t.querySelector(".xterm");
            if (x) x.setAttribute("data-verify-mark", "brainstorm-mode");
            return { xterm: !!x, visible: !t.classList.contains("hidden") };
        })()`);

        // 0b. the reveal attaches: the switcher appears and the tab meta names the file
        let revealError = null;
        try {
            await bsReveal(h, ctx, BS_TOPIC);
        } catch (e) {
            revealError = String(e?.message ?? e);
        }
        const switcher = await polishWaitFor(h, `!!${BS_SWITCH}`, 3000);
        const meta = await bsTabMeta(h, ctx).catch((e) => `error: ${e?.message ?? e}`);
        rec(
            "0b. uireveal brainstorm:<topic> from the agent's terminal attaches it: the header switcher, the tab meta",
            revealError == null && switcher && meta === ctx.file && tagged.visible,
            { revealError, switcher, meta, want: ctx.file, terminalVisible: tagged.visible }
        );
        if (!switcher) return steps;

        // 1. just started
        await bsClick(h, BS_SWITCH, "Brainstorm");
        const s1 = await bsUntil(h, ctx, (s) => s.question.includes(BS_Q1.text));
        await h.shot("cdp-shots/brainstorm-mode-1.png");
        rec(
            "1. just started (Fresh): question 1 fills the pane for Intent and why, the free-text box alone, the skip note, no review head, no Guess for me, nothing decided yet",
            s1.ok &&
                s1.view === "design" &&
                s1.phase === "Talking it through" &&
                s1.progress === "0 of 1 parts yours" &&
                s1.question.startsWith("1 → Intent and why") &&
                s1.title === BS_Q1.text &&
                s1.options.length === 0 &&
                s1.placeholder === "Answer in your own words…" &&
                s1.skipNote ===
                    "Skipping has the agent write every part as its guess. You confirm or edit each one after, before the builder check." &&
                !s1.reviewShown &&
                s1.guessFor === 0 &&
                s1.parts.length === 0 &&
                s1.designBtn === "The design · 0 of 1 yours" &&
                s1.rail === "Decided so far · 0" &&
                s1.history.length === 0 &&
                JSON.stringify(s1.track) === JSON.stringify(["now"]),
            { ...bsBrief(s1), phase: s1.phase, progress: s1.progress, question: s1.question, skipNote: s1.skipNote, reviewShown: s1.reviewShown, guessFor: s1.guessFor, designBtn: s1.designBtn, rail: s1.rail, track: s1.track }
        );
        const opened1 = await bsOpenDesign(h);
        const s1d = await bsRead(h, ctx);
        const asked1 = bsPart(s1d, "intent");
        rec(
            "1b. The design opens over the question: its one part Asked now · question 1, More parts appear, Back to question 1",
            opened1 &&
                s1d.back === "Back to question 1" &&
                s1d.text.includes("More parts appear as the conversation finds them.") &&
                s1d.parts.length === 1 &&
                asked1?.state === "asked" &&
                asked1.text.includes("Asked now · question 1") &&
                asked1.text.includes("Written from your answer to question 1."),
            { opened1, back: s1d.back, parts: s1d.parts }
        );
        const closed1 = await bsCloseDesign(h);
        rec("1c. Back to question 1 shows the question again", closed1 && (await bsRead(h, ctx)).question.includes(BS_Q1.text), { closed1 });
        ctx.agentName = (await h.ev(BS_ROW_READ))?.name ?? "";

        // 2. mid-conversation
        bsWrite(ctx, BS_FILES.mid);
        const s2 = await bsUntil(h, ctx, (s) => s.question.includes(BS_Q4.text) && s.history.length === 4);
        await h.shot("cdp-shots/brainstorm-mode-2.png");
        rec(
            "2. mid-conversation (Main): Talking it through, 3 of 8 parts yours in eight segments, question 4 for When it pages fills the pane, no check button",
            s2.ok &&
                s2.view === "design" &&
                s2.phase === "Talking it through" &&
                s2.progress === "3 of 8 parts yours" &&
                JSON.stringify(s2.segments) ===
                    JSON.stringify(["yours", "yours", "yours", "guess", "guess", "asked", "guess", "open"]) &&
                !s2.toolbar.includes("guesses") &&
                s2.question.startsWith("4 → When it pages") &&
                s2.title === BS_Q4.text &&
                s2.parts.length === 0 &&
                s2.check === null,
            { ...bsBrief(s2), phase: s2.phase, progress: s2.progress, segments: s2.segments, toolbar: s2.toolbar, question: s2.question, title: s2.title, check: s2.check }
        );
        const optionText = (o, i) => `${"ABC"[i]} ${o.label} ${o.detail}${o.pick ? " Agent’s pick" : ""}`;
        rec(
            "2p. the asking state (Main board): why under the question, answers lettered A B C with the agent's pick on A, the free-text box with OK, Guess for me, Skip, The design · 3 of 8 yours, the bar 3 answered then this one",
            s2.why === BS_Q4.why &&
                JSON.stringify(s2.options.map((o) => o.text)) === JSON.stringify(BS_Q4_OPTIONS.map(optionText)) &&
                JSON.stringify(s2.options.map((o) => o.pick)) === JSON.stringify([true, false, false]) &&
                s2.placeholder === "Or type your own answer…" &&
                s2.okBtn?.disabled === true &&
                s2.guessFor === 1 &&
                s2.question.includes("Skip the questions") &&
                s2.designBtn === "The design · 3 of 8 yours" &&
                JSON.stringify(s2.track) === JSON.stringify(["done", "done", "done", "now"]) &&
                s2.skipNote === "",
            { why: s2.why, options: s2.options, placeholder: s2.placeholder, okBtn: s2.okBtn, guessFor: s2.guessFor, designBtn: s2.designBtn, track: s2.track, skipNote: s2.skipNote }
        );
        const [h3, h2, h1, hr] = s2.history;
        rec(
            "2b. Decided so far · 3, newest first then the recon at the bottom, marked new since the design was last seen: Q2 lists all three options it offered, the picked one checked and marked Agent’s pick; each says where it went",
            s2.rail === "Decided so far · 3" &&
                JSON.stringify(s2.history.map((r) => r.label)) === JSON.stringify(["Q3", "Q2", "Q1", "Recon · new"]) &&
                JSON.stringify(h2?.picked) === JSON.stringify([`${BS_Q2_OPTIONS[1].label} Agent’s pick`]) &&
                JSON.stringify(h2?.unpicked) === JSON.stringify([BS_Q2_OPTIONS[0].label, BS_Q2_OPTIONS[2].label]) &&
                h2.text.includes("Went into Goals, Constraints") &&
                JSON.stringify(h1?.picked) === JSON.stringify([BS_HISTORY[0].a]) &&
                h1.unpicked.length === 0 &&
                !h1.text.includes("In your words") &&
                h3?.text.includes("Went into Anti-goals") &&
                hr?.text === `Recon · new ${BS_HISTORY[3].a} Went into Current state`,
            s2.history
        );

        // the design behind its button: the decisions one line each, what stands before the check, the mockups
        const opened2 = await bsOpenDesign(h);
        const pageOpened = await bsOpenRow(h, "page");
        await polishWaitFor(h, `${bsPartSel("page")}?.querySelectorAll("[data-brainstorm-thumb] iframe").length === 2`, BS_POLL_WAIT_MS);
        const thumbs = await h.ev(`(() => {
            const p = ${bsPartSel("page")};
            return {
                frames: p?.querySelectorAll("[data-brainstorm-thumb] iframe").length ?? 0,
                labels: [...(p?.querySelectorAll("[data-brainstorm-open-board]") ?? [])]
                    .map((b) => (b.previousElementSibling?.textContent ?? "").trim()),
            };
        })()`);
        const s2d = await bsRead(h, ctx);
        await h.shot("cdp-shots/brainstorm-mode-2-design.png");
        rec(
            "2m. The design opens over the question, with Back to question 4; the title and spec head it, not the toolbar",
            opened2 &&
                s2d.back === "Back to question 4" &&
                s2d.title === "Consumer lag alerts" &&
                !s2d.toolbar.includes(s2d.title) &&
                !s2d.toolbar.includes(BS_SPEC) &&
                s2d.text.includes(BS_SPEC),
            { opened2, back: s2d.back, title: s2d.title, toolbar: s2d.toolbar }
        );
        rec(
            "2n. Confirm the design heads the decisions: 3 still the agent’s guess, with Confirm all 3 guesses",
            s2d.review === "3 decisions are still the agent’s guess. Each reads in one line; open one to read it whole." &&
                s2d.text.includes("Confirm all 3 guesses") &&
                s2d.text.includes("Decisions · 8"),
            { review: s2d.review }
        );
        // a decision reads in one line until opened; the title line opens and closes it
        const rowBody = `(${bsPartSel("constraints")}?.querySelector("[data-brainstorm-row-body]")?.innerText ?? "").replace(/\\s+/g, " ").trim()`;
        const gist = await h.ev(`(${bsPartSel("constraints")}?.querySelector("[data-brainstorm-gist]")?.innerText ?? "").trim()`);
        const closedBefore = await h.ev(rowBody);
        const openedRow = await bsToggleRow(h, "constraints");
        const openBody = await h.ev(rowBody);
        const closedRow = await bsToggleRow(h, "constraints");
        rec(
            "2o. a decision is one line, its body's first sentence; its title line opens it to the whole body and closes it again",
            gist === BS_PART.constraints.body.split(". ")[0] + "." &&
                closedBefore === "" &&
                openedRow === "true" &&
                openBody === BS_PART.constraints.body &&
                closedRow === "false",
            { gist, closedBefore, openedRow, openBody, closedRow }
        );
        // the rows run in decision order, so compare id -> state pairs, not their order
        const states2c = bsStates(s2d);
        const want2c = Object.entries(BS_MID_STATES);
        rec(
            "2c. part states: yours ×3, guess ×3, asked, open",
            Object.keys(states2c).length === want2c.length && want2c.every(([id, state]) => states2c[id] === state),
            { states: states2c, want: BS_MID_STATES }
        );
        rec(
            "2d. the page part, opened, shows both mockups, the first labelled option A of 2",
            pageOpened && thumbs.frames === 2 && thumbs.labels[0] === "Page.dc.html · option A of 2",
            { pageOpened, ...thumbs }
        );

        let mark = await bsMark(h, ctx, "brainstorm: confirm every guess");
        const allLabel = await h.ev(`(${BS_CONFIRM_ALL}?.textContent ?? "").trim()`);
        const confirmedAll = await bsClick(h, BS_PANE, "Confirm all 3 guesses");
        const allTyped = await bsTyped(h, ctx, mark, "brainstorm: confirm every guess");
        const allLocked = await polishWaitFor(
            h,
            `[...(${bsPartSel("current")}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "That’s right")?.disabled === true`,
            2000
        );
        const allTook = await bsAgentTook(h, ctx);
        rec(
            "2e0. Confirm all 3 guesses sends brainstorm: confirm every guess; the parts lock until the agent takes it",
            allLabel === "Confirm all 3 guesses" && confirmedAll === "clicked" && allTyped.ok && allLocked && allTook,
            { allLabel, confirmedAll, ...allTyped.detail, allLocked, allTook }
        );

        mark = await bsMark(h, ctx, "brainstorm: confirm current");
        const confirmed = await bsClick(h, bsPartSel("current"), "That’s right");
        const confirmTyped = await bsTyped(h, ctx, mark, "brainstorm: confirm current");
        rec("2e. That’s right on Current state sends its confirm", confirmed === "clicked" && confirmTyped.ok, {
            confirmed,
            ...confirmTyped.detail,
        });
        await bsAgentTook(h, ctx);

        const editLine = `brainstorm: edit constraints: ${BS_EDITED}`;
        mark = await bsMark(h, ctx, editLine);
        const editOpened = await bsClick(h, bsPartSel("constraints"), "Edit");
        await polishWaitFor(h, `!!${BS_EDIT}`, 2000);
        const prefill = await h.ev(`${BS_EDIT}?.value ?? null`);
        await bsMouseClick(h, BS_EDIT);
        const via = (await bsKeysArrive(h)) ? "keys" : "set";
        await bsKey(h, BS_EDIT, "Escape", via);
        const escClosed = await h.ev(`!${BS_EDIT}`);
        const escQuiet = await bsNothingTyped(h, mark);
        rec(
            "2f. Edit on Constraints opens prefilled with its body; Escape closes it and sends nothing",
            editOpened === "clicked" && prefill === BS_PART.constraints.body && escClosed && escQuiet.ok,
            { editOpened, prefill, escClosed, typed: escQuiet.sent, keys: via }
        );
        await bsClick(h, bsPartSel("constraints"), "Edit");
        await polishWaitFor(h, `!!${BS_EDIT}`, 2000);
        const editVia = await bsFill(h, BS_EDIT, BS_EDITED);
        await bsKey(h, BS_EDIT, "Enter", editVia);
        const editTyped = await bsTyped(h, ctx, mark, editLine);
        const editClosed = await polishWaitFor(h, `!${BS_EDIT}`, 2000);
        rec("2g. Edit, new text, Enter sends the edit as one line and closes the box", editTyped.ok && editClosed, {
            ...editTyped.detail,
            editClosed,
            keys: editVia,
        });
        await bsAgentTook(h, ctx);
        const closed2 = await bsCloseDesign(h);
        rec("2q. Back to question 4 returns to the question", closed2 && (await bsRead(h, ctx)).question.includes(BS_Q4.text), { closed2 });
        await bsClick(h, `${BS_PANE}?.querySelector("[data-brainstorm-rail]")`, "Anti-goals");
        const railJump = await polishWaitFor(h, `!!${BS_PANE}?.querySelector("[data-brainstorm-back]") && !!${bsPartSel("anti")}`, 3000);
        rec("2r. a Went into link in the rail opens the design at its part", railJump, { railJump });
        await bsCloseDesign(h);

        // a letter focuses its answer and Enter, the row's own key, sends the answer's label
        const OPTION_C = `${BS_PANE}?.querySelector('[data-brainstorm-option="2"]')`;
        const pickLine = BS_Q4_OPTIONS[2].label;
        mark = await bsMark(h, ctx, pickLine);
        await bsMouseClick(h, `${BS_PANE}?.querySelector("h1")`);
        const pickKeys = await bsKeysArrive(h);
        let focused = null;
        if (pickKeys) {
            await pressCanvasKey(h, { key: "c", code: "KeyC", keyCode: 67 });
            focused = await h.ev(`document.activeElement?.getAttribute("data-brainstorm-option") ?? null`);
            await bsKey(h, OPTION_C, "Enter", "keys");
        } else {
            await h.ev(`${OPTION_C}?.click()`);
        }
        const pickTyped = await bsTyped(h, ctx, mark, pickLine);
        rec(
            pickKeys
                ? "2s. c focuses answer C and Enter sends its label as the answer"
                : "2s. clicking answer C sends its label as the answer",
            (!pickKeys || focused === "2") && pickTyped.ok,
            { focused, ...pickTyped.detail }
        );
        if (!pickKeys) {
            steps.push(skipStep("2s2. the letter key itself", "CDP key events never reached the page; clicked the answer instead"));
        }
        await bsAgentTook(h, ctx);

        mark = await bsMark(h, ctx, "brainstorm: guess");
        const guessed = await bsClick(h, BS_QUESTION_CARD, "Guess for me");
        const guessTyped = await bsTyped(h, ctx, mark, "brainstorm: guess");
        rec("2h. Guess for me sends brainstorm: guess", guessed === "clicked" && guessTyped.ok, {
            guessed,
            ...guessTyped.detail,
        });
        await bsAgentTook(h, ctx);
        mark = await bsMark(h, ctx, "brainstorm: skip questions");
        const skipped = await bsClick(h, BS_QUESTION_CARD, "Skip the questions");
        const skipTyped = await bsTyped(h, ctx, mark, "brainstorm: skip questions");
        rec("2i. Skip the questions sends brainstorm: skip questions", skipped === "clicked" && skipTyped.ok, {
            skipped,
            ...skipTyped.detail,
        });
        await bsAgentTook(h, ctx);

        const answerLine = BS_ANSWER_LINES.join(" ");
        mark = await bsMark(h, ctx, answerLine);
        const answerVia = await bsFill(h, BS_ANSWER, BS_ANSWER_LINES[0]);
        await bsKey(h, BS_ANSWER, "Enter", answerVia, true);
        if (answerVia === "keys") {
            await h.cdp("Input.insertText", { text: BS_ANSWER_LINES[1] });
        } else {
            await h.ev(bsSetValue(BS_ANSWER, BS_ANSWER_LINES.join("\n")));
        }
        const twoLines = await h.ev(`${BS_ANSWER}?.value ?? null`);
        const shiftQuiet = await bsNothingTyped(h, mark);
        rec(
            "2j. Shift+Enter puts a newline in the answer and sends nothing",
            twoLines === BS_ANSWER_LINES.join("\n") && shiftQuiet.ok,
            { value: twoLines, typed: shiftQuiet.sent, keys: answerVia }
        );
        await bsKey(h, BS_ANSWER, "Enter", answerVia);
        const answerTyped = await bsTyped(h, ctx, mark, answerLine);
        // the box empties, or closes with the question while the agent writes the answer up
        const cleared = await polishWaitFor(h, `(${BS_ANSWER}?.value ?? "") === ""`, 2000);
        rec("2k. Enter sends the two lines as one line and clears the box", answerTyped.ok && cleared, {
            ...answerTyped.detail,
            cleared,
        });
        const s2w = await bsUntil(h, ctx, (s) => s.working !== "", 3000);
        await h.shot("cdp-shots/brainstorm-mode-2-sent.png");
        rec(
            "2k2. a sent answer reads as the agent writing it up, before the file changes: Working in the question's place, no answer box",
            s2w.ok &&
                s2w.working.includes("Writing up your answer.") &&
                !s2w.answerBox &&
                s2w.question === "" &&
                s2w.treeLine === "writing up your answer",
            { ...bsBrief(s2w), working: s2w.working, answerBox: s2w.answerBox, treeLine: s2w.treeLine }
        );
        const opened2w = await bsOpenDesign(h);
        const s2wd = await bsRead(h, ctx);
        const sentPart = bsPart(s2wd, "thresholds");
        rec(
            "2k3. The design behind it: When it pages Being written, and the way back to what the agent is writing",
            opened2w && sentPart?.state === "writing" && s2wd.back === "Back to what the agent is writing",
            { opened2w, part: sentPart, back: s2wd.back }
        );
        await bsCloseDesign(h);

        bsWrite(ctx, BS_FILES.answered);
        const s2b = await bsUntil(h, ctx, (s) => s.question.includes(BS_Q5.text));
        await h.shot("cdp-shots/brainstorm-mode-2-answered.png");
        const q4row = s2b.history[0];
        rec(
            "2l. the next file: question 5 for What on-call sees, and Q4 tops the rail: the answers it offered unpicked with the agent’s pick marked, then the typed one In your words, into When it pages",
            s2b.ok &&
                s2b.question.startsWith("5 → What on-call sees") &&
                s2b.rail === "Decided so far · 4" &&
                q4row?.label === "Q4" &&
                JSON.stringify(q4row.unpicked) === JSON.stringify(BS_Q4_OPTIONS.map((o) => (o.pick ? o.label + " Agent’s pick" : o.label))) &&
                JSON.stringify(q4row.picked) === JSON.stringify([`In your words ${answerLine}`]) &&
                q4row.text.includes("Went into When it pages"),
            { ...bsBrief(s2b), question: s2b.question, rail: s2b.rail, history: q4row }
        );

        // the asked part's mockups in the question: question 4's part (When it pages) lists none, question 5's two
        const QB = `${BS_PANE}?.querySelectorAll("[data-brainstorm-question] [data-brainstorm-thumb] iframe").length === 2`;
        await polishWaitFor(h, QB, BS_POLL_WAIT_MS);
        const s2q = await bsRead(h, ctx);
        await h.shot("cdp-shots/brainstorm-mode-2-question-boards.png");
        const boardLabels = BS_BOARDS.map((b, i) => `${b} · option ${"AB"[i]} of ${BS_BOARDS.length}`);
        rec(
            "2l2. a question whose part lists boards shows them: question 5 for What on-call sees draws both thumbnails, option A and B of 2, each with Open full size; question 4, whose part lists none, drew none",
            s2.qBoards.length === 0 &&
                JSON.stringify(s2q.qBoards.map((b) => b.name)) === JSON.stringify(BS_BOARDS) &&
                s2q.qBoards.every((b) => b.frame && b.open === "Open full size") &&
                JSON.stringify(s2q.qBoards.map((b) => b.label)) === JSON.stringify(boardLabels),
            { q4: s2.qBoards, q5: s2q.qBoards }
        );
        bsWrite(ctx, BS_FILES.layout);
        const s2o = await bsUntil(
            h,
            ctx,
            (s) => s.question.includes(BS_Q5_LAYOUT.text) && s.options.length === 2 && s.qBoards.filter((b) => b.frame).length === 2
        );
        await h.shot("cdp-shots/brainstorm-mode-2-layout-question.png");
        rec(
            "2l3. a question between the part's layouts: the two answers, and beside them, to their right, the two boards to compare",
            s2o.ok &&
                JSON.stringify(s2o.options.map((o) => o.text)) === JSON.stringify(BS_Q5_LAYOUT.options.map(optionText)) &&
                JSON.stringify(s2o.qBoards.map((b) => b.label)) === JSON.stringify(boardLabels) &&
                s2o.qBoards.every((b) => b.besideAnswers === true),
            { ...bsBrief(s2o), options: s2o.options, boards: s2o.qBoards }
        );
        await h.ev(`${BS_PANE}?.querySelector("[data-brainstorm-question] [data-brainstorm-open-board]")?.click()`);
        const s2f = await bsUntil(h, ctx, (s) => s.view === "board", 3000);
        const fullBack = await bsClick(h, BS_PANE, "Back to the question");
        const s2r = await bsUntil(h, ctx, (s) => s.view === "design" && s.question.includes(BS_Q5_LAYOUT.text), 3000);
        rec(
            "2l4. Open full size from the question shows the board, and its Back to the question returns to the question",
            s2f.ok && fullBack === "clicked" && s2r.ok && s2r.qBoards.length === 2,
            { board: s2f.view, fullBack, back: bsBrief(s2r) }
        );
        // Esc takes the back control's step; on the question there is no step left, so a second Esc changes nothing
        await bsMouseClick(h, `${BS_PANE}?.querySelector("[data-brainstorm-question] [data-brainstorm-open-board]")`);
        const s2e = await bsUntil(h, ctx, (s) => s.view === "board", 3000);
        const escVia = await bsEscape(h);
        const s2eq = await bsUntil(h, ctx, (s) => s.view === "design" && s.question.includes(BS_Q5_LAYOUT.text), 3000);
        await h.shot("cdp-shots/brainstorm-mode-2-esc-board-to-question.png");
        await bsEscape(h);
        await polishNap(500);
        const s2stay = await bsRead(h, ctx);
        rec(
            `2l5. Esc on the board opened full size from the question returns to the question, and a second Esc there leaves it be (${escVia === "keys" ? "a real Esc key" : "a keydown on the document: CDP keys did not reach the page"})`,
            s2e.ok && s2eq.ok && s2eq.qBoards.length === 2 && s2stay.view === "design" && s2stay.question.includes(BS_Q5_LAYOUT.text),
            { board: s2e.view, via: escVia, back: bsBrief(s2eq), again: bsBrief(s2stay) }
        );
        bsWrite(ctx, BS_FILES.answered);
        await bsUntil(h, ctx, (s) => s.question.includes(BS_Q5.text));

        // 3. open full size, from the design
        await bsOpenDesign(h);
        await bsOpenRow(h, "page");
        await polishWaitFor(h, `!!${bsPartSel("page")}?.querySelector("[data-brainstorm-open-board]")`, 3000);
        await h.ev(`${bsPartSel("page")}?.querySelector("[data-brainstorm-open-board]")?.click()`);
        const s3 = await bsUntil(h, ctx, (s) => s.view === "board", 3000);
        const board = await h.ev(`(() => {
            const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
            const labels = [...(${BS_PANE}?.querySelectorAll("button") ?? [])].map(flat);
            return { mark: labels.includes("Mark"), back: labels.includes("Back to the design"), canvas: !!${BS_PANE}?.querySelector("[data-canvas-pane]") };
        })()`);
        await h.shot("cdp-shots/brainstorm-mode-3.png");
        await bsClick(h, BS_PANE, "Back to the design");
        const s3back = await bsUntil(h, ctx, (s) => s.view === "design" && s.parts.length > 0, 3000);
        rec(
            "3. Open full size shows the board with Mark and Back to the design; back returns to the design, not the question",
            s3.ok && board.mark && board.back && board.canvas && s3back.ok && s3back.back === "Back to question 5",
            { board: s3.view, ...board, back: s3back.view, parts: s3back.parts.length, backBtn: s3back.back }
        );
        // Esc, one level per press: the board opened off the design back to the design, then the design to the question
        await bsOpenRow(h, "page");
        await polishWaitFor(h, `!!${bsPartSel("page")}?.querySelector("[data-brainstorm-open-board]")`, 3000);
        await bsMouseClick(h, `${bsPartSel("page")}?.querySelector("[data-brainstorm-open-board]")`);
        const s3e = await bsUntil(h, ctx, (s) => s.view === "board", 3000);
        const esc3 = await bsEscape(h);
        const s3d = await bsUntil(h, ctx, (s) => s.view === "design" && s.back === "Back to question 5" && s.parts.length > 0, 3000);
        await h.shot("cdp-shots/brainstorm-mode-3-esc-board-to-design.png");
        await bsEscape(h);
        const s3q = await bsUntil(h, ctx, (s) => s.view === "design" && s.back === "" && s.question.includes(BS_Q5.text), 3000);
        await h.shot("cdp-shots/brainstorm-mode-3-esc-design-to-question.png");
        rec(
            `3b. Esc steps back one level per press: from the board opened off the design to the design, then from the design to question 5 (${esc3 === "keys" ? "a real Esc key" : "a keydown on the document: CDP keys did not reach the page"})`,
            s3e.ok && s3d.ok && s3q.ok,
            { board: s3e.view, via: esc3, design: { ...bsBrief(s3d), back: s3d.back }, question: { ...bsBrief(s3q), back: s3q.back } }
        );
        await bsCloseDesign(h);

        // 4. between questions
        bsWrite(ctx, BS_FILES.working);
        const s4 = await bsUntil(h, ctx, (s) => s.working !== "");
        await h.shot("cdp-shots/brainstorm-mode-4.png");
        rec(
            "4. between questions: Working in the question's place, no answer box, The design button, Q4 · just now in the rail",
            s4.ok &&
                s4.working.includes("Writing “When it pages” from your answer. The next question comes after.") &&
                !s4.answerBox &&
                s4.question === "" &&
                s4.designBtn === "The design · 3 of 8 yours" &&
                s4.history[0]?.label === "Q4 · just now",
            { ...bsBrief(s4), working: s4.working, answerBox: s4.answerBox, designBtn: s4.designBtn, newest: s4.history[0] }
        );
        await bsOpenDesign(h);
        const s4d = await bsRead(h, ctx);
        await h.shot("cdp-shots/brainstorm-mode-4-design.png");
        const writing = bsPart(s4d, "thresholds");
        rec(
            "4b. the design while the agent writes: the note atop it says actions open again when it asks, When it pages Being written, confirms disabled, no review head",
            s4d.workingNote ===
                "The agent is writing. Confirm, edit and keep open again when it asks its next question." &&
                writing?.state === "writing" &&
                writing.text.includes("Being written") &&
                s4d.confirm.length > 0 &&
                s4d.confirm.every((b) => b.disabled) &&
                !s4d.reviewShown &&
                s4d.phase === "Talking it through",
            { workingNote: s4d.workingNote, writing, confirm: s4d.confirm, reviewShown: s4d.reviewShown, phase: s4d.phase }
        );
        rec("4c. the design while the agent writes holds the line box, locked", s4d.lineBox === "locked", {
            lineBox: s4d.lineBox,
        });
        await bsCloseDesign(h);

        // 5. a confirmed part changed
        bsWrite(ctx, BS_FILES.changed);
        await bsUntil(h, ctx, (s) => s.question.includes(BS_Q5.text));
        await bsOpenDesign(h);
        const s5 = await bsUntil(h, ctx, (s) => bsPart(s, "constraints")?.state === "changed");
        const diff = await h.ev(`(() => {
            const p = ${bsPartSel("constraints")};
            const rows = [...(p?.querySelectorAll("div") ?? [])].filter((d) => d.firstElementChild?.textContent === "+ ");
            return rows.map((d) => (d.textContent ?? "").trim());
        })()`);
        await h.shot("cdp-shots/brainstorm-mode-5.png");
        const changed = bsPart(s5, "constraints");
        rec(
            "5. a confirmed part changed: its row opens by itself on Changed since you confirmed it, the added sentence as a + line, Why; the head counts it",
            s5.ok &&
                changed.text.includes("Changed since you confirmed it") &&
                diff.length === 1 &&
                diff[0] === `+ ${BS_ADDED}` &&
                changed.text.includes(`Why: ${BS_WHY}`) &&
                s5.review ===
                    "2 decisions are still the agent’s guess. 1 decision changed since you confirmed it. Each reads in one line; open one to read it whole.",
            { ...bsBrief(s5), part: changed?.text, diff, review: s5.review }
        );
        mark = await bsMark(h, ctx, "brainstorm: keep constraints");
        const kept = await bsClick(h, bsPartSel("constraints"), "Keep the change");
        const keepTyped = await bsTyped(h, ctx, mark, "brainstorm: keep constraints");
        rec("5b. Keep the change sends brainstorm: keep constraints", kept === "clicked" && keepTyped.ok, {
            kept,
            ...keepTyped.detail,
        });
        await bsAgentTook(h, ctx);
        mark = await bsMark(h, ctx, "brainstorm: restore constraints");
        const restored = await bsClick(h, bsPartSel("constraints"), "Put mine back");
        const restoreTyped = await bsTyped(h, ctx, mark, "brainstorm: restore constraints");
        rec("5c. Put mine back sends brainstorm: restore constraints", restored === "clicked" && restoreTyped.ok, {
            restored,
            ...restoreTyped.detail,
        });
        await bsAgentTook(h, ctx);
        await bsCloseDesign(h);

        // 6. after a compaction: b goes back to the terminal, which was hidden, not remounted
        await bsMouseClick(h, `${BS_PANE}?.querySelector("span.font-mono")`);
        const delivered = await bsKeysArrive(h);
        const pressB = async (to) => {
            if (delivered) await pressCanvasKey(h, BS_B_KEY);
            else await bsClick(h, BS_SWITCH, to);
        };
        await pressB("Terminal");
        const s6 = await bsUntil(h, ctx, (s) => s.view == null && s.terminal === true, 3000);
        const same = await h.ev(`(() => {
            const t = ${TERM};
            const x = t?.querySelector(".xterm");
            return {
                sameNode: t?.getAttribute("data-verify-mark") === "brainstorm-mode",
                sameXterm: x == null ? null : x.getAttribute("data-verify-mark") === "brainstorm-mode",
            };
        })()`);
        const keyed = delivered ? "b" : "the Terminal segment (CDP keys did not reach the page)";
        rec(
            `6. ${keyed} returns to the terminal, the same node, Terminal pressed and the footer view chip`,
            s6.ok &&
                same.sameNode &&
                (tagged.xterm ? same.sameXterm === true : true) &&
                s6.switch?.find((b) => b.label === "Terminal")?.pressed === "true" &&
                s6.hint.includes("view"),
            { ...bsBrief(s6), terminal: s6.terminal, ...same, switch: s6.switch, hint: s6.hint }
        );
        bsWrite(ctx, { ...BS_FILES.late, compacted: Date.now() });
        const banner =
            "The agent compacted its context and re-read its brainstorm file: 5 parts yours, 2 guesses, 1 open. Nothing was lost.";
        const s6b = await bsUntil(h, ctx, (s) => s.compacted !== "");
        await h.shot("cdp-shots/brainstorm-mode-6.png");
        rec("6b. a compaction since brainstorm mode was last shown puts the banner over the terminal", s6b.compacted === banner, {
            ok: s6b.ok,
            ms: s6b.ms,
            compacted: s6b.compacted,
        });
        // back in the terminal the xterm holds focus and would take the b; leave it the way Esc does
        await h.ev(`(() => {
            document.activeElement?.blur?.();
            document.querySelector("[data-cockpit-surface-wrap]")?.focus();
            return true;
        })()`);
        await pressB("Brainstorm");
        const s6c = await bsUntil(h, ctx, (s) => s.view != null, 3000);
        await pressB("Terminal");
        const s6d = await bsUntil(h, ctx, (s) => s.view == null && s.terminal === true, 3000);
        rec(
            `6c. ${delivered ? "b" : "the Brainstorm segment"} shows the brainstorm; back in the terminal the banner is gone`,
            s6c.ok && s6d.ok && s6d.compacted === "",
            { shown: s6c.view, back: s6d.ok, compacted: s6d.compacted }
        );
        if (!delivered) {
            steps.push(skipStep("6d. the b key itself", "CDP key events never reached the page; drove the switcher instead"));
        }
        // 6e. Ctrl+Shift+B switches while the xterm holds focus, where b and Ctrl+G b cannot
        if (delivered) {
            const pressChord = async () => {
                const k = { key: "B", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: BS_CTRL_SHIFT };
                await h.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
                await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k });
                await polishNap(500);
            };
            const inXterm = `document.activeElement?.classList.contains("xterm-helper-textarea") === true`;
            await h.ev(`${TERM}?.querySelector(".xterm-helper-textarea")?.focus()`);
            const typing = await h.ev(inXterm);
            await pressChord();
            const s6e = await bsUntil(h, ctx, (s) => s.view != null, 3000);
            await pressChord();
            const s6f = await bsUntil(h, ctx, (s) => s.view == null && s.terminal === true, 3000);
            const backInXterm = await h.ev(inXterm);
            rec(
                "6e. Ctrl+Shift+B from inside the terminal shows the brainstorm, and again returns to typing in the xterm",
                typing && s6e.ok && s6f.ok && backInXterm,
                { typing, shown: s6e.view, back: s6f.ok, backInXterm }
            );
            await h.ev(`(() => {
                document.activeElement?.blur?.();
                document.querySelector("[data-cockpit-surface-wrap]")?.focus();
                return true;
            })()`);
        } else {
            steps.push(skipStep("6e. Ctrl+Shift+B from inside the terminal", "CDP key events never reached the page"));
        }

        // 7. the tree line and the attention popup
        bsWrite(ctx, BS_FILES.late);
        const s7 = await bsUntil(h, ctx, (s) => s.treeLine === "asking question 5");
        const row = await h.ev(BS_ROW_READ);
        rec(
            "7. the agent's row reads asking question 5, with the asking dot",
            s7.ok && (row.dotStyle ?? "").includes("var(--color-warning)") && row.dotPulse === true,
            { treeLine: s7.treeLine, ...row }
        );
        let popup = null;
        try {
            popup = ctx.popup = await h.page("popup.html");
        } catch (e) {
            steps.push(skipStep("7b. the popup shows the question", `no popup page: ${e?.message ?? e}`));
        }
        if (popup) {
            // the question leaves the outward list, then comes back while Arc reads as unfocused: new to the popup
            await h.ev("document.hasFocus = () => false");
            bsWrite(ctx, BS_FILES.lateWorking);
            const away = await bsUntil(h, ctx, (s) => s.treeLine === "writing up your answer");
            bsWrite(ctx, BS_FILES.late);
            const start = Date.now();
            let card;
            do {
                card = await popup.ev(BS_POPUP_READ).catch((e) => ({ error: String(e?.message ?? e) }));
                if (card.visible === true && card.text === BS_Q5.text) break;
                await polishNap(150);
            } while (Date.now() - start < BS_POLL_WAIT_MS);
            if (card.card) await popup.shot("cdp-shots/brainstorm-mode-7-popup.png");
            await h.shot("cdp-shots/brainstorm-mode-7.png");
            await h.ev("delete document.hasFocus");
            await h.ev(`window.dispatchEvent(new Event("focus"))`);
            rec(
                "7b. unfocused, a new question raises the popup: <agent> · brainstorm, the question, For “What on-call sees” · question 5",
                away.ok &&
                    card.visible === true &&
                    ctx.agentName !== "" &&
                    card.label === `${ctx.agentName} · brainstorm` &&
                    card.text === BS_Q5.text &&
                    card.detail === "For “What on-call sees” · question 5",
                { away: away.treeLine, agent: ctx.agentName, card }
            );
        }

        // 7c. ready: every part yours, nothing left to ask
        bsWrite(ctx, BS_READY);
        await bsShowPane(h);
        const s7c = await bsUntil(h, ctx, (s) => s.check != null);
        await h.shot("cdp-shots/brainstorm-mode-ready.png");
        rec(
            "7c. ready: 8 of 8 parts yours, Confirm the design says every decision is yours and holds Check with a builder",
            s7c.ok &&
                s7c.view === "design" &&
                s7c.phase === "Talking it through" &&
                s7c.progress === "8 of 8 parts yours" &&
                s7c.segments.length === 8 &&
                s7c.segments.every((x) => x === "yours") &&
                s7c.review === "Every decision is yours. Next, a fresh agent reads the design as a builder would." &&
                s7c.check?.disabled === false &&
                !s7c.text.includes("Confirm all"),
            { ...bsBrief(s7c), phase: s7c.phase, progress: s7c.progress, review: s7c.review, check: s7c.check }
        );
        // 7c2. no question open: a line of the user's own goes to the agent as typed, as an answer does
        const LINE_BOX = `${BS_PANE}?.querySelector("[data-brainstorm-line-box] textarea")`;
        const pushback = "Why not reuse the alerting we have?";
        mark = await bsMark(h, ctx, pushback);
        const lineVia = await bsFill(h, LINE_BOX, pushback);
        await bsKey(h, LINE_BOX, "Enter", lineVia);
        const lineTyped = await bsTyped(h, ctx, mark, pushback);
        await h.shot("cdp-shots/brainstorm-mode-ready-line.png");
        rec("7c2. with no question open, the line box sends a typed line to the agent as typed", s7c.lineBox === "open" && lineTyped.ok, {
            lineBox: s7c.lineBox,
            ...lineTyped.detail,
        });
        await bsAgentTook(h, ctx);
        await bsUntil(h, ctx, (s) => s.check?.disabled === false);
        mark = await bsMark(h, ctx, "brainstorm: check");
        const checked = await bsClick(h, `${BS_PANE}?.querySelector("[data-brainstorm-review]")`, "Check with a builder");
        const checkTyped = await bsTyped(h, ctx, mark, "brainstorm: check");
        rec("7d. Check with a builder sends brainstorm: check", checked === "clicked" && checkTyped.ok, {
            checked,
            ...checkTyped.detail,
        });

        // 10. agent exited
        bsWrite(ctx, BS_FILES.late);
        await bsUntil(h, ctx, (s) => s.view === "design" && s.question.includes(BS_Q5.text));
        await bsPublishProc(h, ctx, "done", 1);
        const s10 = await bsUntil(h, ctx, (s) => s.view === "exited", 3000);
        await h.shot("cdp-shots/brainstorm-mode-10.png");
        const summary =
            "The brainstorm is saved: 5 parts yours, 2 guesses, and question 5 still unanswered. A new agent reads it and carries on from that question.";
        const exitedHead = new RegExp(`^${ctx.agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} exited with code 1 at \\d{2}:\\d{2} `);
        rec(
            "10. the agent exited: <name> exited with code 1 at, what is saved, Resume in a new agent",
            s10.ok && ctx.agentName !== "" && exitedHead.test(s10.exited) && s10.exited.includes(summary) && s10.resume,
            { exited: s10.exited, agent: ctx.agentName, resume: s10.resume }
        );
        await bsClick(h, BS_PANE, "Open the design");
        const s10b = await bsUntil(h, ctx, (s) => s.view === "design" && s.parts.length > 0, 2000);
        rec("10b. Open the design shows the design itself, not the question", s10b.ok && s10b.title === "Consumer lag alerts", { view: s10b.view, parts: s10b.parts.length, title: s10b.title });
        await bsPublishProc(h, ctx, "running", 0);

        // 11. an unreadable file. Over a file read before, the last good contents stay with a banner
        bsWrite(ctx, '{ "v": 1, "title": ');
        const s11 = await bsUntil(h, ctx, (s) => s.stale !== "", BS_ERROR_WAIT_MS);
        await h.shot("cdp-shots/brainstorm-mode-11-stale.png");
        rec(
            "11. a broken rewrite keeps the last good design, with the could-not-read banner after two polls",
            s11.ok && s11.view === "design" && s11.stale.includes("this is the last version it read") && s11.stale.includes("not valid JSON"),
            { view: s11.view, ms: s11.ms, stale: s11.stale }
        );
        // with no good read behind it, a broken file is the error view; a second topic replaces the first
        const unreadable = join(ctx.cwd, ".superpowers", "brainstorm", BS_UNREADABLE_TOPIC, "brainstorm.json");
        mkdirSync(dirname(unreadable), { recursive: true });
        writeFileSync(unreadable, "{ not json");
        let reveal2 = null;
        try {
            await bsReveal(h, ctx, BS_UNREADABLE_TOPIC);
        } catch (e) {
            reveal2 = String(e?.message ?? e);
        }
        const meta2 = await bsTabMeta(h, ctx).catch((e) => `error: ${e?.message ?? e}`);
        await bsShowPane(h);
        const s11b = await bsUntil(h, ctx, (s) => s.view === "error", BS_ERROR_WAIT_MS);
        await h.shot("cdp-shots/brainstorm-mode-11.png");
        rec(
            "11b. a second topic's unreadable file replaces the first: the error view with the parse error and the path",
            reveal2 == null &&
                meta2 === unreadable &&
                s11b.ok &&
                s11b.text.includes("Arc could not read this brainstorm") &&
                s11b.text.includes("not valid JSON") &&
                s11b.text.includes(unreadable),
            { reveal2, meta2, ...bsBrief(s11b) }
        );

        // 12. file gone
        bsWrite(ctx, BS_FILES.late);
        let reveal3 = null;
        try {
            await bsReveal(h, ctx, BS_TOPIC);
        } catch (e) {
            reveal3 = String(e?.message ?? e);
        }
        await bsShowPane(h);
        const s12a = await bsUntil(h, ctx, (s) => s.view === "design" && s.question.includes(BS_Q5.text));
        rmSync(ctx.file, { force: true });
        const s12 = await bsUntil(h, ctx, (s) => s.view === "removed");
        await h.shot("cdp-shots/brainstorm-mode-12.png");
        rec(
            "12. deleting brainstorm.json shows that the file is gone",
            reveal3 == null && s12a.ok && s12.ok && s12.text.includes(`${BS_TOPIC}'s brainstorm file is gone`),
            { reveal3, back: s12a.view, ...bsBrief(s12) }
        );
        const backed = await bsClick(h, BS_PANE, "Back to terminal");
        const s12b = await bsUntil(h, ctx, (s) => s.view == null && s.switch == null && s.terminal === true, 3000);
        const meta3 = await bsTabMeta(h, ctx).catch((e) => `error: ${e?.message ?? e}`);
        await h.shot("cdp-shots/brainstorm-mode-12-back.png");
        rec(
            "12b. Back to terminal: no pane, the terminal visible, no brainstorm switcher, the tab meta cleared",
            backed === "clicked" && s12b.ok && meta3 == null,
            { backed, view: s12b.view, switch: s12b.switch, terminal: s12b.terminal, meta3 }
        );
        return steps;
    },
    // best-effort, so one failed step does not strand the rest
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`brainstorm-mode teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("restore document.hasFocus", () => h.ev("delete document.hasFocus"));
        // the app's own hide: the main window gaining focus
        await step("hide the popup", () => h.ev(`window.dispatchEvent(new Event("focus"))`));
        await step("close the popup's session", () => ctx.popup?.close());
        await step("close the New run window", () => h.ev(`${NEW_RUN} ? (${PEEKS_ESC}, true) : false`));
        await step("stop recording sent lines", () => h.ev(BS_TYPED_REMOVE));
        if (ctx.blockId) await step("clear the exit", () => bsPublishProc(h, ctx, "running", 0));
        if (ctx.tabId) {
            await step("close the terminal tab", () =>
                waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false])
            );
        }
        if (ctx.project) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.project }));
        await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};

// --- brainstorm reasons: the boards of .superpowers/design/brainstorm-question-center, one scenario each. Each opens
// a terminal as brainstorm-mode does, reveals one brainstorm.json and judges the state its board draws. Nothing is
// sent to the agent: brainstorm-mode covers the lines -----------------------------------------------------------------

// a terminal made a roster agent, with the file written; teardown removes whatever was made
async function bsArrangeAgent(h, topic, file) {
    const cwd = mkdtempSync(join(tmpdir(), "verify-bs-reasons-"));
    const ctx = { cwd, topic, file: join(cwd, ".superpowers", "brainstorm", topic, "brainstorm.json") };
    try {
        mkdirSync(dirname(ctx.file), { recursive: true });
        bsWrite(ctx, file);
        await openCanvasTerminal(h, ctx, topic);
        await bsPublishStatus(h, ctx);
    } catch (e) {
        ctx.launchError = String(e?.message ?? e);
        return ctx;
    }
    await h.goto("agent");
    ctx.inRoster = await polishWaitFor(
        h,
        `!!document.querySelector('[data-agent-terminal="${ctx.tabId}"]') && !document.querySelector('[data-tree-terminal="${ctx.tabId}"]')`,
        BS_ROSTER_WAIT_MS
    );
    return ctx;
}

// reveals the file from the agent's terminal and shows its pane; null once drawn, else why it could not be
async function bsShowFile(h, ctx) {
    if (ctx.launchError != null) return `the terminal launch failed: ${ctx.launchError}`;
    if (!ctx.inRoster) return "the terminal never became a roster agent";
    try {
        await bsReveal(h, ctx, ctx.topic);
    } catch (e) {
        return `the reveal failed: ${e?.message ?? e}`;
    }
    if (!(await polishWaitFor(h, `!!${BS_SWITCH}`, 3000))) return "the reveal drew no brainstorm switcher";
    if (!(await bsShowPane(h))) return "the Brainstorm segment drew no pane";
    return null;
}

async function bsTeardownAgent(h, ctx, name) {
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`${name} teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    if (ctx.tabId) {
        await step("close the terminal tab", () => waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false]));
    }
    await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
    await step("go home", () => h.goto("cockpit"));
}

// a brainstorm-reasons scenario: arrange the agent with `file`, show it, then `check` the drawn pane
const bsBoardScenario = (name, topic, file, check) => ({
    name,
    surface: "agent",
    arrange: (h) => bsArrangeAgent(h, topic, file),
    async assert(h, ctx) {
        const missing = await bsShowFile(h, ctx);
        if (missing != null) return [skipStep(name, `could not verify: ${missing}`)];
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        await check(h, ctx, rec);
        return steps;
    },
    teardown: (h, ctx) => bsTeardownAgent(h, ctx, name),
});

// clicks a design row's title line, opening or closing it; what aria-expanded reads after
async function bsToggleRow(h, id) {
    await h.ev(`${bsPartSel(id)}?.querySelector("[data-brainstorm-row-toggle]")?.click()`);
    await polishNap(200);
    return h.ev(`${bsPartSel(id)}?.querySelector("[data-brainstorm-row-toggle]")?.getAttribute("aria-expanded") ?? null`);
}

// opens a design row unless it is open already
async function bsOpenRow(h, id) {
    const expanded = await h.ev(`${bsPartSel(id)}?.querySelector("[data-brainstorm-row-toggle]")?.getAttribute("aria-expanded") ?? null`);
    return expanded === "true" ? true : (await bsToggleRow(h, id)) === "true";
}

// the open question with each answer's reasons; the copy is the Question-Reasons board's
const BSR_Q = {
    n: 2,
    text: "Which blind spot should the first new model close: relationships between entities, each entity’s rhythm over time, the order of its actions, or a wider set of detectors on the same daily features?",
    part: "direction",
    why: "The research says a fancier model over the same daily feature vector gains little. The gains come from showing a model something the engine can’t see today. Each of these blind spots needs different data and catches a different kind of attack, so this choice decides most of the design.",
    read: "graph adds the most new detection, forecast is the safest measurable win, sequence is a separate project, and more detectors on the same features is a cleanup rather than an upgrade.",
    options: [
        {
            label: "Relationships (graph model)",
            pick: true,
            detail: "Learns who normally reaches what and flags unlikely new connections.",
            pros: [
                "A signal the engine has none of today. Every current model looks at one entity alone.",
                "Targets lateral movement and new access paths, which per-entity volume models are weakest at. A quiet attacker using one new path barely moves a z-score.",
                "The data partly exists: the hourly aggregates keep seen_srcips, seen_services and seen_countries per entity, so an edge list can be built without raw ES.",
                "Light first version: a co-occurrence or matrix-factorisation link score in numpy or scipy. No torch needed.",
            ],
            cons: [
                "Edges carry no counts or order, only “seen in this hour”.",
                "Each detection is about a pair, not an entity, so evidence and explanation need a new shape.",
                "New infrastructure (DHCP churn, a new server) looks like a new edge, a classic false-positive source.",
                "Published numbers are inflated: the 85% TPR result was filtered to NTLM logons only.",
            ],
        },
        {
            label: "Rhythm over time (forecast model)",
            detail: "Predicts each entity’s expected volume for the day and flags what falls outside it.",
            pros: [
                "Directly fixes a known weakness: the z-score compares against a flat 6-month mean, so routine Monday peaks and nightly batch jobs read as spikes.",
                "Builds on stored aggregates; a classical seasonal model needs only numpy or scipy.",
                "Easy to explain to an analyst: “expected 40–60 at this hour, saw 900”.",
                "Has a cheap honest test: replay history and count how many current z-score detections it would have suppressed.",
            ],
            cons: [
                "Mostly a noise cutter, so it catches few new kinds of threat.",
                "Hourly rows are purged after 7 days, so only a daily-grain model has months of history today.",
                "Only works for entities with enough history (the HIGH tier). LOW and DORMANT gain nothing.",
            ],
        },
        {
            label: "Order of actions (sequence model)",
            detail: "Learns the typical order of events per user or host.",
            pros: [
                "The strongest published results for insider threat and account takeover.",
                "Catches multi-step behaviour (recon, then access, then exfiltration) that any per-day count hides.",
            ],
            cons: [
                "Needs per-event sequences; the engine stores only aggregates, so this needs a new ES-to-PG pipeline at 71.5M logs a day.",
                "Needs torch or equivalent, plus GPU or long CPU training per tenant.",
                "The evidence is almost all on synthetic CERT data, and it is the hardest to explain.",
            ],
        },
        {
            label: "More detectors on the same features",
            detail: "ECOD, COPOD and kNN beside IsolationForest.",
            pros: [
                "Cheapest option: about a day of work, on the same 50-feature vector and trainer base class.",
                "ECOD and COPOD are parameter-free and give per-feature contributions, which explain better than IsolationForest.",
            ],
            cons: [
                "Benchmarks show no reliable winner and only small gains: the same blind spots through a different lens.",
                "More correlated detectors push the same evidence up the scorer, which risks double-counting.",
            ],
        },
    ],
};
const BSR_TITLE = "Improving the detection engine: which models to add";
const BSR_SPEC = "docs/superpowers/specs/2026-10-21-detector-engine-models-design.md";
const bsrFile = (over) => ({ v: 1, title: BSR_TITLE, spec: BSR_SPEC, question: null, working: null, parts: [], history: [], done: false, check: null, run: null, ...over });
const BSR_QUESTION_FILE = bsrFile({
    question: BSR_Q,
    parts: [
        { id: "intent", title: "Intent and why", state: "guess", from: "answer 1", gist: "Catch new kinds of attack, not rescore the ones the engine already finds.", body: "Raise the engine beyond its current basic models so it catches more real attacks." },
        { id: "direction", title: "Which blind spot first", state: "asked", body: "" },
        { id: "today", title: "What the engine runs today", kind: "note", from: "recon", gist: "Every model scores one entity per day over a flat feature vector.", body: "Each entity is scored on its own, one day at a time." },
    ],
    history: [
        { kind: "question", n: 1, q: "Walk me through the last time the engine let you down?", a: "No I just want to improve the engine in general, it uses some models but they are all basic models", into: ["intent"] },
        { kind: "recon", q: "I offered to read the engine's models and storage.", a: "Every model scores one entity per day over a flat feature vector. There is nothing on relationships, sequences or seasonal shape, and the literature says the gains are there rather than in a fancier tabular model.", into: ["today"] },
    ],
});

// every answer of the asked question: its button's text, and its for and against lists as drawn
const BSR_READ_OPTIONS = `(() => {
    const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
    const pane = ${BS_PANE};
    const toggle = pane?.querySelector("[data-brainstorm-proscons-toggle]");
    return {
        read: flat(pane?.querySelector("[data-brainstorm-read]")),
        toggle: toggle ? { text: flat(toggle), expanded: toggle.getAttribute("aria-expanded") } : null,
        options: [...(pane?.querySelectorAll("[data-brainstorm-option]") ?? [])].map((b) => {
            const card = b.parentElement;
            const list = (label) => [...(card.querySelector('ul[aria-label$="' + label + '"]')?.querySelectorAll("li") ?? [])].map(flat);
            return { text: flat(b), pick: b.hasAttribute("data-pick"), pros: list(": for"), cons: list(": against") };
        }),
    };
})()`;

export const brainstormQuestionReasons = bsBoardScenario("brainstorm-question-reasons", "detector-engine-models", BSR_QUESTION_FILE, async (h, ctx, rec) => {
    const drawn = await bsUntil(h, ctx, (s) => s.question.includes(BSR_Q.text) && s.options.length === 4);
    await h.ev(`${BS_PANE}?.querySelector("[data-brainstorm-read]")?.scrollIntoView({ block: "start" })`);
    const shown = await h.ev(BSR_READ_OPTIONS);
    await h.shot("cdp-shots/brainstorm-question-reasons.png");
    const letters = "ABCD";
    const optionText = (o, i) => `${letters[i]} ${o.label} ${o.detail}${o.pick ? " Agent’s pick" : ""}`;
    const sign = (mark, items) => items.map((t) => `${mark} ${t}`);
    rec(
        "1. the open question (Question-Reasons): Agent’s read above the answers with Hide pros and cons, each answer keeps letter, label, detail and the agent's pick, then its pros (+) and cons (−) in two lists",
        drawn.ok &&
            shown.read === `Agent’s read: ${BSR_Q.read}` &&
            shown.toggle?.text === "Hide pros and cons" &&
            shown.toggle.expanded === "true" &&
            JSON.stringify(shown.options.map((o) => o.text)) === JSON.stringify(BSR_Q.options.map(optionText)) &&
            JSON.stringify(shown.options.map((o) => o.pick)) === JSON.stringify([true, false, false, false]) &&
            JSON.stringify(shown.options.map((o) => o.pros)) === JSON.stringify(BSR_Q.options.map((o) => sign("+", o.pros))) &&
            JSON.stringify(shown.options.map((o) => o.cons)) === JSON.stringify(BSR_Q.options.map((o) => sign("−", o.cons))) &&
            drawn.why === BSR_Q.why,
        { ...bsBrief(drawn), shown, why: drawn.why }
    );
    const grid = await h.ev(`(() => {
        const ul = ${BS_PANE}?.querySelector('[data-brainstorm-option="0"]')?.parentElement?.querySelectorAll("ul");
        if (!ul || ul.length !== 2) return null;
        const a = ul[0].getBoundingClientRect();
        const b = ul[1].getBoundingClientRect();
        return { sideBySide: b.left > a.right - 1 && Math.abs(a.top - b.top) < 2 };
    })()`);
    rec("1b. the pros and cons sit side by side, pros on the left", grid?.sideBySide === true, grid);
    await bsClick(h, BS_PANE, "Hide pros and cons");
    const hidden = await h.ev(BSR_READ_OPTIONS);
    await h.shot("cdp-shots/brainstorm-question-reasons-hidden.png");
    await bsClick(h, BS_PANE, "Show pros and cons");
    const again = await h.ev(BSR_READ_OPTIONS);
    rec(
        "2. Hide pros and cons hides every answer's lists and keeps the read and the answers; Show pros and cons brings them back",
        hidden.toggle?.text === "Show pros and cons" &&
            hidden.toggle.expanded === "false" &&
            hidden.read === shown.read &&
            hidden.options.length === 4 &&
            hidden.options.every((o) => o.pros.length === 0 && o.cons.length === 0) &&
            again.toggle?.text === "Hide pros and cons" &&
            again.options.every((o) => o.pros.length > 0),
        { hidden, again: again.toggle }
    );
});

// a question with no pros, cons or read draws as today's (Main board): nothing added around the answers
export const brainstormMainBoard = bsBoardScenario("brainstorm-main", BS_TOPIC, BS_FILES.mid, async (h, ctx, rec) => {
    const s = await bsUntil(h, ctx, (x) => x.question.includes(BS_Q4.text) && x.history.length === 4);
    const extra = await h.ev(BSR_READ_OPTIONS);
    const proscons = await h.ev(`${BS_PANE}?.querySelectorAll("[data-brainstorm-proscons]").length ?? -1`);
    await h.shot("cdp-shots/brainstorm-main.png");
    const optionText = (o, i) => `${"ABC"[i]} ${o.label} ${o.detail}${o.pick ? " Agent’s pick" : ""}`;
    rec(
        "1. a question with no pros, cons or read (Main): why under it, answers A B C with the agent's pick, the answer box, Guess, Skip and The design, and no read line, toggle or reason lists",
        s.ok &&
            s.question.startsWith("4 → When it pages") &&
            s.why === BS_Q4.why &&
            JSON.stringify(s.options.map((o) => o.text)) === JSON.stringify(BS_Q4_OPTIONS.map(optionText)) &&
            s.placeholder === "Or type your own answer…" &&
            s.guessFor === 1 &&
            s.question.includes("Skip the questions") &&
            s.designBtn === "The design · 3 of 8 yours" &&
            extra.read === "" &&
            extra.toggle === null &&
            proscons === 0,
        { ...bsBrief(s), why: s.why, options: s.options, extra, proscons }
    );
});

// the design before the builder check; the copy is the Review-Skim board's
const BSR_DECISIONS = [
    { id: "intent", title: "Intent and why", from: "answer 1", state: "guess", gist: "Catch new kinds of attack, not rescore the ones the engine already finds.", body: "Raise the engine beyond its current basic models so it catches more real attacks. There is no specific missed incident or noise complaint behind this; the aim is a general upgrade of what the models can detect." },
    { id: "direction", title: "Which blind spot first", from: "answer 2", state: "yours", gist: "Both a graph model and a forecast model, as separate detectors.", body: "Both: a relationship (graph) model and a rhythm-over-time (forecast) model. Each is a separate detector that reads different data and catches a different kind of thing, so they can be built and shipped independently." },
    { id: "order", title: "Order and packaging", from: "answer 3", state: "yours", gist: "Forecast first, shipped on its own; the graph model gets its own brainstorm after.", body: "Forecast model first, designed and shipped on its own. The graph model is a second brainstorm and spec afterwards, reusing the forecast’s replay-and-compare evaluation harness." },
    { id: "grain", title: "Forecast grain", from: "answer 4, my call", state: "guess", gist: "Daily: one forecast per entity-day and numeric field, with a weekday cycle.", body: "Daily grain: forecast each entity-day’s value for each numeric field from the daily aggregates, with a weekday cycle." },
    { id: "role", title: "Where the forecast sits", from: "answer 6", state: "yours", gist: "One more detector behind _run_detector_safely, with no weight of its own.", body: "No change to detection or scoring logic. The forecast runs behind _run_detector_safely and reshapes the existing z-score evidence; it has no weight of its own in the tier weight table." },
    { id: "purpose", title: "What the forecast adds", from: "answer 9, my call", state: "guess", gist: "No weight of its own: it damps or raises the existing z-score evidence only.", body: "The forecast has no detector weight of its own. It only reshapes the existing z_score Evidence record for a numeric field on a HIGH-tier entity.\n- Value inside the forecast interval: damp the strength, never below a floor (a setting).\n- Value outside the interval and the seasonal residual larger than the flat z: raise the strength.\n- Otherwise, or with no forecast: the record is unchanged." },
    { id: "evaluation", title: "How we know it is better", from: "answer 10", state: "yours", gist: "Live from day one behind a setting; the stored undamped strength is the safety net.", body: "Live from day one. A setting turns the forecast adjustment on or off; it ships on. Turning it off is a restart. The safety net is the stored undamped strength: a query over anomaly_detections lists every detection the forecast damped." },
    { id: "model", title: "The forecast model", from: "answer 11, my call", state: "guess", gist: "Robust weekday profile: median and MAD of the last N weeks, no trend.", body: "Robust weekday profile, with no trend.\n- For each numeric monitored field and each weekday, take that weekday’s daily values from the last N weeks of the baseline window: the median as the expected value, and the MAD (scaled by 1.4826) as the spread. Interval = median +/- k x spread.\n- Computed at baseline time and stored in the baseline JSONB beside the existing calibration tails.\n- N, k, M and the damping floor are settings." },
    { id: "builder", title: "Left to the builder", from: "my call", state: "guess", gist: "The strength formula, where the reshaping runs, and the values of N, k and M.", body: "- How the adjustment maps to strength: the builder picks the exact formula, keeping it monotonic and bounded.\n- Where the reshaping runs.\n- Starting values for N, k, M and the damping floor." },
];
const BSR_NOTES = [
    { id: "today", title: "What the engine runs today", from: "recon", gist: "Every model scores one entity per day over a flat feature vector.", body: "Each entity is scored on its own, one day at a time.\n- Statistics: z-score against a 6-month mean and standard deviation (HIGH tier), percentage-change multipliers (MEDIUM), first-seen values plus peer-group median and percentiles (LOW and DORMANT).\n- ML: one sklearn IsolationForest per tenant and entity type, over a 50-feature daily vector." },
    { id: "research", title: "What the research says", from: "recon", gist: "The gains are in new signals (relationships, rhythm, order), not a fancier tabular model.", body: "- Tabular detectors: ADBench (NeurIPS 2022, 30 algorithms on 57 datasets) found that no unsupervised method is reliably best." },
    { id: "constraints", title: "Constraints", from: "recon", gist: "Unsupervised, tenant-scoped, one more detector behind _run_detector_safely.", body: "- Must stay unsupervised or weakly supervised, because analyst labels are scarce.\n- A new model enters as one more detector behind _run_detector_safely.\n- Tenant-scoped models and data only." },
    { id: "tradeoffs", title: "Pros and cons of each direction", from: "recon", gist: "Graph adds the most new detection; forecast is the safest measurable win.", body: "Graph adds the most new detection, forecast is the safest measurable win, sequence is a separate project, and more detectors on the same features is a cleanup rather than an upgrade." },
    { id: "damping", title: "Damping: gains and losses", from: "recon, answer 7", gist: "Worth doing at the evidence level, never at the modifier stage.", body: "Worth doing, but at the evidence level, not the modifier stage." },
    { id: "walkthrough", title: "Evidence-level damping, step by step", from: "recon, answer 8", gist: "A VPN gateway’s routine Monday peak drops from about 35 points to about 9.", body: "Monday, 900 logins: the flat z-score is 4.2, worth about 35 points. 900 falls inside the forecast range, so that one piece of evidence is damped to the floor, about 9 points." },
];
const BSR_HISTORY = [
    { kind: "question", n: 9, q: "Should the forecast get its own detector weight, or only reshape the existing z-score evidence?", a: "(guess) reshape the z-score evidence only", into: ["purpose"] },
    { kind: "question", n: 10, q: "Should the forecast go live as soon as it ships, or run a shadow period first and switch on only if the replay looks right?", a: "Live from day one, behind a setting", into: ["evaluation"] },
    { kind: "question", n: 11, q: "Which forecaster should produce the expected value and range for each weekday?", a: "(guess) robust weekday profile", into: ["model"] },
];
const bsrReviewFile = (allYours) =>
    bsrFile({
        done: allYours,
        parts: [
            ...BSR_DECISIONS.map((d) => ({ ...d, state: allYours ? "yours" : d.state })),
            ...BSR_NOTES.map((n) => ({ ...n, kind: "note" })),
        ],
        history: BSR_HISTORY,
    });

const BSR_READ_REVIEW = `(() => {
    const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
    const pane = ${BS_PANE};
    const rows = (sel) => [...(pane?.querySelectorAll(sel + " [data-brainstorm-part]") ?? [])].map((p) => ({
        id: p.getAttribute("data-brainstorm-part"),
        state: p.getAttribute("data-state"),
        gist: flat(p.querySelector("[data-brainstorm-gist]")),
        buttons: [...p.querySelectorAll("button:not([data-brainstorm-row-toggle])")].map(flat),
        open: p.querySelector("[data-brainstorm-row-toggle]")?.getAttribute("aria-expanded"),
        body: flat(p.querySelector("[data-brainstorm-row-body]")),
    }));
    return {
        review: flat(pane?.querySelector("[data-brainstorm-review]")),
        line: flat(pane?.querySelector("[data-brainstorm-review-line]")),
        confirmAll: flat(pane?.querySelector("[data-brainstorm-confirm-all]")),
        checkBtn: flat(pane?.querySelector("[data-brainstorm-check-btn]")),
        decisionsHead: flat(pane?.querySelector("[data-brainstorm-decisions] h2")),
        notesHead: flat(pane?.querySelector("[data-brainstorm-notes] h2")),
        decisions: rows("[data-brainstorm-decisions]"),
        notes: rows("[data-brainstorm-notes]"),
        progress: flat(pane?.querySelector("[data-brainstorm-progress]")),
    };
})()`;

export const brainstormReviewSkim = bsBoardScenario("brainstorm-review-skim", "detector-engine-models", bsrReviewFile(false), async (h, ctx, rec) => {
    const drawn = await bsUntil(h, ctx, (s) => s.parts.length === BSR_DECISIONS.length + BSR_NOTES.length);
    const opened = await bsOpenRow(h, "model");
    const r = await h.ev(BSR_READ_REVIEW);
    await h.shot("cdp-shots/brainstorm-review-skim.png");
    const guesses = BSR_DECISIONS.filter((d) => d.state === "guess");
    // the pane lists decisions newest first
    const shown = [...BSR_DECISIONS].reverse();
    const wantRight = (d) => (d.state === "guess" ? ["That’s right", "Edit"] : ["Edit"]);
    rec(
        "1. the design before the builder check (Review-Skim): Confirm the design with Confirm all 5 guesses, each decision one row of title, gist and source with That’s right and Edit, or Yours and Edit",
        drawn.ok &&
            r.line === "5 decisions are still the agent’s guess. Each reads in one line; open one to read it whole." &&
            r.confirmAll === `Confirm all ${guesses.length} guesses` &&
            r.checkBtn === "" &&
            r.decisionsHead === `Decisions · ${BSR_DECISIONS.length}` &&
            JSON.stringify(r.decisions.map((d) => [d.id, d.state, d.gist])) ===
                JSON.stringify(shown.map((d) => [d.id, d.state, d.gist])) &&
            r.decisions.every((d, i) => JSON.stringify(d.buttons) === JSON.stringify(wantRight(shown[i]))) &&
            r.progress === "4 of 9 parts yours",
        { ...bsBrief(drawn), line: r.line, confirmAll: r.confirmAll, head: r.decisionsHead, decisions: r.decisions.map((d) => [d.id, d.state, d.gist, d.buttons]), progress: r.progress }
    );
    const model = r.decisions.find((d) => d.id === "model");
    const closedBody = r.decisions.filter((d) => d.id !== "model").every((d) => d.open === "false" && d.body === "");
    rec(
        "2. a row opens to its whole body; the rest stay one line",
        opened && model?.open === "true" && model.body === BSR_DECISIONS.find((d) => d.id === "model").body.replace(/\s+/g, " ") && closedBody,
        { opened, model, closedBody }
    );
    rec(
        "3. What the agent found · 6 sits apart, each note one line with an Edit and nothing to confirm",
        r.notesHead === `What the agent found · ${BSR_NOTES.length}` &&
            JSON.stringify(r.notes.map((n) => [n.id, n.state, n.gist])) === JSON.stringify(BSR_NOTES.map((n) => [n.id, "note", n.gist])) &&
            r.notes.every((n) => JSON.stringify(n.buttons) === JSON.stringify(["Edit"])),
        { head: r.notesHead, notes: r.notes.map((n) => [n.id, n.state, n.gist, n.buttons]) }
    );
    bsWrite(ctx, bsrReviewFile(true));
    const ready = await polishWaitFor(h, `!!${BS_PANE}?.querySelector("[data-brainstorm-check-btn]")`, BS_POLL_WAIT_MS);
    const r2 = await h.ev(BSR_READ_REVIEW);
    await h.shot("cdp-shots/brainstorm-review-skim-ready.png");
    rec(
        "4. once every decision is yours, Confirm all becomes Check with a builder; the notes still need nothing",
        ready &&
            r2.checkBtn === "Check with a builder" &&
            r2.confirmAll === "" &&
            r2.line === "Every decision is yours. Next, a fresh agent reads the design as a builder would." &&
            r2.decisions.every((d) => d.state === "yours") &&
            r2.progress === "9 of 9 parts yours",
        { ready, line: r2.line, checkBtn: r2.checkBtn, confirmAll: r2.confirmAll, progress: r2.progress }
    );
});

// the rail keeps the agent's reasons; the copy is the Rail-Reasons board's
const BSR_RAIL_HISTORY = [
    {
        kind: "question",
        n: 1,
        q: "What should count as a lag problem?",
        why: "Lag alone is a number; whether it is a problem depends on whether it grows or holds. Only you know which one has hurt before.",
        a: "Lag that stays high, not a spike.",
        into: ["alert"],
        options: [
            { label: "Any lag above the threshold", detail: "The simplest rule; it also fires on every short spike." },
            { label: "Lag that keeps growing for 10 minutes", detail: "Catches a stalled consumer early and ignores a spike that is already draining.", pick: true },
        ],
    },
    {
        kind: "question",
        n: 2,
        q: "One threshold for every group, or one per group?",
        why: "Groups in services/*/kafka.yaml range from a few hundred messages a day to millions an hour, so one number may fit none of them.",
        a: "Per group, with a default to start from",
        into: ["threshold"],
        picked: 1,
        options: [
            { label: "One threshold for every group", detail: "One number to tune. Small groups never cross it and large ones always do." },
            { label: "Per group, with a default to start from", detail: "Every group alerts from day one; teams tighten the default for the groups they know.", pick: true },
            { label: "Per group, every team must set one", detail: "Most precise, but no group alerts until its team writes a number." },
        ],
    },
    {
        kind: "question",
        n: 3,
        q: "What happens to a spike that recovers inside the window?",
        why: "A spike that clears within 10 minutes is usually a rebalance or a deploy. I can’t tell from the repo whether anyone wants to hear about those.",
        a: "Post it to #data-alerts, page no one",
        into: ["alert"],
        picked: 1,
        options: [
            { label: "Page anyway: a spike is still lag", detail: "Nothing slips past, but every deploy that triggers a rebalance wakes someone." },
            { label: "Post it to #data-alerts, page no one", detail: "The owning team sees it next morning; nobody is woken for lag that cleared by itself.", pick: true },
            { label: "Drop it: nobody hears about it", detail: "Quietest, but a group that spikes every night is never noticed." },
        ],
    },
    {
        kind: "recon",
        q: "I offered to read the consumer configs and the alerting config.",
        a: "Read services/*/kafka.yaml and the alerting config: every consumer group names an owning team; nothing pages on lag today.",
        into: [],
    },
];
const BSR_RAIL_FILE = bsFile({
    title: "Consumer lag alerts",
    question: {
        n: 4,
        text: "When a consumer group stays past its lag threshold, who gets paged first: the team that owns the consumer, or platform on-call?",
        part: "who",
        why: "Every consumer group names an owning team, so paging by owner needs no new config. I can’t tell whether every team keeps a rota.",
        options: [
            { label: "Owning team first, platform after 15 minutes", detail: "Pages go to who can fix it.", pick: true },
            { label: "Platform on-call first", detail: "One rota to keep." },
        ],
    },
    parts: [
        { id: "alert", title: "What raises an alert", state: "yours", body: "Lag that keeps growing for 10 minutes. A spike that recovers inside the window posts to #data-alerts and pages no one." },
        { id: "threshold", title: "The threshold", state: "yours", body: "Per group, with a default to start from." },
        { id: "who", title: "Who gets paged", state: "asked", body: "" },
    ],
    history: BSR_RAIL_HISTORY,
});

const BSR_READ_RAIL = `(() => {
    const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
    return [...(${BS_PANE}?.querySelectorAll("[data-brainstorm-history] > div") ?? [])].map((r) => {
        const toggle = r.querySelector("[data-brainstorm-reasoning]");
        return {
            label: flat(r.querySelector("span")),
            why: flat(r.querySelector("[data-brainstorm-rail-why]")),
            picked: [...r.querySelectorAll("li[data-picked]")].map(flat),
            unpicked: [...r.querySelectorAll("li:not([data-picked])")].map(flat),
            toggle: toggle ? { text: flat(toggle), expanded: toggle.getAttribute("aria-expanded") } : null,
        };
    });
})()`;

export const brainstormRailReasons = bsBoardScenario("brainstorm-rail-reasons", BS_TOPIC, BSR_RAIL_FILE, async (h, ctx, rec) => {
    const drawn = await bsUntil(h, ctx, (s) => s.history.length === BSR_RAIL_HISTORY.length);
    const closed = await h.ev(BSR_READ_RAIL);
    const [q1, q2, q3, recon] = BSR_RAIL_HISTORY;
    const pickText = (o) => `${o.label}${o.pick ? " Agent’s pick" : ""}`;
    const [c3, c2, c1, cr] = closed;
    rec(
        "1. Decided so far keeps reasons: the picked answer shows what it is, Agent’s pick marks the agent's recommendation, the others show only their label, each entry with Show the reasoning, the recon with none",
        drawn.ok &&
            JSON.stringify(closed.map((r) => r.label)) === JSON.stringify(["Q3", "Q2", "Q1", "Recon"]) &&
            JSON.stringify(c3.picked) === JSON.stringify([`${pickText(q3.options[1])} ${q3.options[1].detail}`]) &&
            JSON.stringify(c3.unpicked) === JSON.stringify([q3.options[0].label, q3.options[2].label]) &&
            c3.why === "" &&
            c3.toggle?.text === "Show the reasoning" &&
            c2.toggle?.text === "Show the reasoning" &&
            JSON.stringify(c1.unpicked) === JSON.stringify(q1.options.map(pickText)) &&
            JSON.stringify(c1.picked) === JSON.stringify([`In your words ${q1.a}`]) &&
            cr.toggle === null &&
            !JSON.stringify(cr).includes(recon.q),
        { ...bsBrief(drawn), closed }
    );
    await h.ev(`${BS_PANE}?.querySelector("[data-brainstorm-history] > div:first-child [data-brainstorm-reasoning]")?.click()`);
    await polishNap(200);
    const opened = await h.ev(BSR_READ_RAIL);
    await h.shot("cdp-shots/brainstorm-rail-reasons.png");
    const [o3, o2] = opened;
    rec(
        "2. Show the reasoning on Q3 opens Why: and the other answers' details, and reads Hide the reasoning; Q2 stays closed",
        o3.why === `Why: ${q3.why}` &&
            JSON.stringify(o3.unpicked) === JSON.stringify([`${q3.options[0].label} ${q3.options[0].detail}`, `${q3.options[2].label} ${q3.options[2].detail}`]) &&
            o3.toggle?.text === "Hide the reasoning" &&
            o3.toggle.expanded === "true" &&
            o2.why === "" &&
            JSON.stringify(o2.unpicked) === JSON.stringify([q2.options[0].label, q2.options[2].label]),
        { q3: o3, q2: o2 }
    );
});

// the brainstorm helpers the scenarios-brainstorm-*.mjs modules build on, which scenarios.mjs hands them
export const BS_KIT = {
    bsBoardScenario,
    bsArrangeAgent,
    bsShowFile,
    bsShowPane,
    bsTeardownAgent,
    bsWrite,
    bsRead,
    bsUntil,
    bsBrief,
    bsClick,
    bsMouseClick,
    bsFill,
    bsKey,
    bsKeysArrive,
    bsMark,
    bsTyped,
    bsNothingTyped,
    bsAgentTook,
    bsPublishStatus,
    bsPublishProc,
    bsOpenDesign,
    bsCloseDesign,
    bsTermText,
    bsReveal,
    bsTabMeta,
    bsFile,
    bsParts,
    bsPartSel,
    bsOpenRow,
    bsToggleRow,
    polishWaitFor,
    polishNap,
    skipStep,
    waveService,
    arrangeSheetDagRun,
    teardownFixtureRun,
    seedDag,
    seedFinalShots,
    fstShow,
    fstWriteRun,
    RUN_SHEET_POLISH_TASKS,
    UI_ROUTE,
    BS_PANE,
    BS_SWITCH,
    BS_TREE_LINE,
    BS_ANSWER,
    BS_BUILDER_ANSWER,
    BS_APPROVE_BAR,
    BS_QUESTION_CARD,
    BS_NOT_WRITING,
    BS_POLL_WAIT_MS,
    BS_TOPIC,
    BS_SPEC,
    BS_BOARDS,
    BS_RUN,
    BS_PART,
    BS_FILES,
    BS_HISTORY_Q4,
    BS_HANDOFF_PARTS,
    BS_CHECK,
    BS_HANDOFF,
    BS_HANDOFF_ANSWERED,
    BS_READY,
    BS_TOUCHED_ORDER,
    BS_BUILDER_Q,
    BS_BUILDER_A,
    BS_SIDE_Q,
    BS_SIDE_A,
    NEW_RUN,
    PEEKS_ESC,
    flatText,
};
