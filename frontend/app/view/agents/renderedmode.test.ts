import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormFile, BuilderCheckView } from "./brainstormmodel";
import { brainstormAnswersAtom, brainstormsAtom, type BrainstormState } from "./brainstormstore";
import {
    answersLabel,
    BASH_PLACEHOLDER,
    boxButton,
    brainstormRoute,
    canRender,
    composerBox,
    contextRing,
    effectiveViewMode,
    isPickerCommand,
    pickerFlipAtom,
    sendRoutedLine,
    shouldUnflip,
    toggleViewMode,
    viewModeAtom,
} from "./renderedmode";

const agent = (over: Partial<AgentVM> = {}): AgentVM => ({
    id: "tab-1",
    name: "loom",
    task: "",
    state: "idle",
    agent: "claude",
    blockId: "b-1",
    ...over,
});

const LIVE = { ended: false, stage: false };

describe("canRender", () => {
    it("is true for a claude agent with a live block", () => {
        expect(canRender(agent(), LIVE)).toBe(true);
    });
    it("is false for the runtimes the rendered view does not drive", () => {
        for (const rt of ["pi", "codex", "opencode"]) {
            expect(canRender(agent({ agent: rt }), LIVE)).toBe(false);
        }
    });
    it("is false for a plain terminal and for an agent with no block", () => {
        expect(canRender(agent({ kind: "terminal" }), LIVE)).toBe(false);
        expect(canRender(agent({ blockId: undefined }), LIVE)).toBe(false);
    });
    it("is false for an ended worker and a final-stage row", () => {
        expect(canRender(agent(), { ended: true, stage: false })).toBe(false);
        expect(canRender(agent(), { ended: false, stage: true })).toBe(false);
    });
});

describe("isPickerCommand", () => {
    it("is true for a picker command and a bare /model", () => {
        expect(isPickerCommand("/config")).toBe(true);
        expect(isPickerCommand("/model")).toBe(true);
        expect(isPickerCommand("  /config")).toBe(true);
        expect(isPickerCommand("  /model  ")).toBe(true);
    });
    it("is false for /model with an alias, other commands and plain text", () => {
        expect(isPickerCommand("/model opus")).toBe(false);
        expect(isPickerCommand("/compact")).toBe(false);
        expect(isPickerCommand("/review x")).toBe(false);
        expect(isPickerCommand("fix the config")).toBe(false);
        expect(isPickerCommand("/configure")).toBe(false);
    });
});

describe("effectiveViewMode", () => {
    it("is terminal while a picker flip is set", () => {
        expect(effectiveViewMode("rendered", 5)).toBe("terminal");
    });
    it("is the chosen mode with no flip", () => {
        expect(effectiveViewMode("rendered", null)).toBe("rendered");
        expect(effectiveViewMode("terminal", null)).toBe("terminal");
    });
});

describe("shouldUnflip", () => {
    it("unflips on a prompt-boundary hook after the flip only", () => {
        expect(shouldUnflip(100, { hook: "Stop", ts: 99 })).toBe(false);
        expect(shouldUnflip(100, { hook: "Stop", ts: 101 })).toBe(true);
        expect(shouldUnflip(100, { hook: "UserPromptSubmit", ts: 101 })).toBe(true);
        expect(shouldUnflip(100, { hook: "SessionStart", ts: 101 })).toBe(true);
    });
    it("stays flipped on hooks that fire while a picker is open", () => {
        expect(shouldUnflip(100, { hook: "Notification", ts: 101 })).toBe(false);
        expect(shouldUnflip(100, { hook: "PostToolUse", ts: 101 })).toBe(false);
    });
    it("is false with no flip or no hook yet", () => {
        expect(shouldUnflip(null, { hook: "Stop", ts: 101 })).toBe(false);
        expect(shouldUnflip(100, null)).toBe(false);
    });
});

const ASK = {
    questions: [{ header: "Scope", question: "Which scope?", multiSelect: false, options: [{ label: "a" }] }],
} as AgentVM["ask"];

describe("composerBox", () => {
    it("is idle for an agent with a transcript, new for one without, and offers Send", () => {
        const idle = composerBox(agent(), true);
        expect(idle).toMatchObject({ kind: "idle", askBlocks: false, live: false });
        expect(idle.placeholder).toContain("loom");
        const fresh = composerBox(agent(), false);
        expect(fresh.kind).toBe("new");
        expect(fresh.placeholder).toContain("loom");
        expect(fresh.placeholder).not.toBe(idle.placeholder);
        expect(boxButton(idle, false)).toBe("send");
        expect(boxButton(idle, true)).toBe("send");
    });
    it("while working, an empty box offers Stop and a filled one Send (steer)", () => {
        const box = composerBox(agent({ state: "working" }), true);
        expect(box).toMatchObject({ kind: "working", askBlocks: false, live: true });
        expect(box.placeholder).not.toBe(composerBox(agent(), true).placeholder);
        expect(boxButton(box, false)).toBe("stop");
        expect(boxButton(box, true)).toBe("send");
    });
    it("while an answerable ask is shown, Send is blocked and the empty box offers Stop", () => {
        const box = composerBox(agent({ state: "asking", ask: ASK }), true);
        expect(box).toMatchObject({ askBlocks: true, live: true });
        expect(boxButton(box, false)).toBe("stop");
        expect(boxButton(box, true)).toBe("send");
    });
    it("an asking state with no answerable question does not block Send", () => {
        expect(composerBox(agent({ state: "asking" }), true).askBlocks).toBe(false);
    });
    it("in bash mode shows the bash placeholder in every state and keeps the rest", () => {
        const cases: [Partial<AgentVM>, boolean][] = [
            [{}, true],
            [{}, false],
            [{ state: "working" }, true],
            [{ state: "asking", ask: ASK }, true],
        ];
        for (const [over, hasTranscript] of cases) {
            const prompt = composerBox(agent(over), hasTranscript);
            const bash = composerBox(agent(over), hasTranscript, true);
            expect(bash).toEqual({ ...prompt, placeholder: BASH_PLACEHOLDER, sendLabel: "Run" });
        }
    });
    it("without bash mode, the placeholder is unchanged", () => {
        expect(composerBox(agent(), true, false)).toEqual(composerBox(agent(), true));
    });
    it("labels Send Run in bash mode, idle or working", () => {
        expect(composerBox(agent(), true, true).sendLabel).toBe("Run");
        expect(composerBox(agent({ state: "working" }), true, true).sendLabel).toBe("Run");
    });
    it("labels Send Steer while working and Send otherwise outside bash mode", () => {
        expect(composerBox(agent({ state: "working" }), true).sendLabel).toBe("Steer");
        expect(composerBox(agent(), true).sendLabel).toBe("Send");
        expect(composerBox(agent(), false).sendLabel).toBe("Send");
    });
});

const BS_FILE: BrainstormFile = {
    v: 1,
    title: "Consumer lag alerts",
    spec: "docs/specs/lag.md",
    canvas: "lag",
    question: null,
    working: null,
    parts: [{ id: "page", title: "What on-call sees", state: "yours", body: "b" }],
    history: [],
    done: true,
    check: null,
    run: null,
};
const Q5 = { n: 5, text: "What does the banner say?", part: "page" };
const BUILDER_Q = "Should a page hold the autoscaler?";
const CHECKED = { yours: [], calls: [], answered: [] };
const GUESS = [{ id: "page", title: "What on-call sees", state: "guess" as const, body: "b" }];
const NO_CHECK: BuilderCheckView = { kind: "none" };
const bs = (file: BrainstormFile | null, over: Partial<BrainstormState> = {}): BrainstormState =>
    ({
        topic: "lag",
        path: "/p/bs.json",
        cwd: "/p",
        file,
        sent: null,
        picks: {},
        removed: false,
        ...over,
    }) as BrainstormState;
const routed = (file: BrainstormFile, over: Partial<BrainstormState> = {}, check: BuilderCheckView = NO_CHECK) =>
    brainstormRoute(bs(file, over), check);
const NORMAL_IDLE = composerBox(agent(), true);

describe("brainstormRoute and the box's words", () => {
    it("a talk question open: the box answers question N, labelled only once filled", () => {
        const box = composerBox(agent(), true, false, routed({ ...BS_FILE, done: false, question: Q5 }));
        expect(box.placeholder).toBe("Answer question 5 in your own words, or push back");
        expect(answersLabel(box, false)).toBeNull();
        expect(answersLabel(box, true)).toBe("Answers question 5");
        expect(box.hint).toBeNull();
    });
    it("the judge weighing the question still routes the box to it", () => {
        const judging: BrainstormFile = {
            ...BS_FILE,
            done: false,
            working: "The judge is weighing 2 approaches.",
            question: { ...Q5, approaches: [{ name: "A", description: "", facts: [] }] },
        };
        expect(routed(judging)).toEqual({ kind: "talk", n: 5 });
    });
    it("a builder question open: the box answers the builder's question", () => {
        const f = { ...BS_FILE, check: { ...CHECKED, yours: [{ q: BUILDER_Q }] } };
        const box = composerBox(agent(), true, false, routed(f));
        expect(box.placeholder).toBe("Answer the builder's question in your own words, or push back");
        expect(answersLabel(box, true)).toBe("Answers the builder's question");
    });
    it("a talk question open over a builder question routes to the talk question", () => {
        const f = { ...BS_FILE, done: false, question: Q5, check: { ...CHECKED, yours: [{ q: BUILDER_Q }] } };
        expect(routed(f)).toEqual({ kind: "talk", n: 5 });
    });
    it("no question and the line box open with no guess waiting: the normal placeholder and the hint", () => {
        const box = composerBox(agent(), true, false, routed(BS_FILE));
        expect(box.placeholder).toBe(NORMAL_IDLE.placeholder);
        expect(box.hint).toBe("No question open · your line reaches the brainstorm as pushback or a question back");
        expect(answersLabel(box, true)).toBeNull();
        expect(box.route).toEqual({ kind: "line", hint: true });
    });
    it("a guess waiting to confirm in the talk phase: still a pushback line, with no hint", () => {
        const box = composerBox(agent(), true, false, routed({ ...BS_FILE, parts: GUESS }));
        expect(box.route).toEqual({ kind: "line", hint: false });
        expect(box.hint).toBeNull();
        expect(box.placeholder).toBe(NORMAL_IDLE.placeholder);
    });
    it("after the builder check (keep talking) a reopened guess keeps the hint", () => {
        expect(routed({ ...BS_FILE, parts: GUESS, check: CHECKED })).toEqual({ kind: "line", hint: true });
    });
    it("the pane working: no route, so the working agent's box is the normal steer box", () => {
        const writing = routed({ ...BS_FILE, working: "Writing the banner part." });
        expect(writing).toBeNull();
        const box = composerBox(agent({ state: "working" }), true, false, writing);
        expect(box).toEqual(composerBox(agent({ state: "working" }), true));
        expect(box.placeholder).toBe("Steer the agent; it reads this before its next step");
        expect(boxButton(box, false)).toBe("stop");
    });
    it("a line sent and not yet taken reads as the pane working: no route", () => {
        const sent = { at: 1, modifiedMs: 1, kind: "answer" as const };
        expect(routed({ ...BS_FILE, done: false, question: Q5 }, { sent })).toBeNull();
    });
    it("a builder check pending locks the line box: no route", () => {
        expect(routed(BS_FILE, {}, { kind: "pending", stage: "reading", text: "reading" })).toBeNull();
    });
    it("a run started, a removed brainstorm, no file or no brainstorm: no route, the normal box", () => {
        expect(routed({ ...BS_FILE, check: CHECKED, run: "r1" })).toBeNull();
        expect(brainstormRoute(bs(BS_FILE, { removed: true }), NO_CHECK)).toBeNull();
        expect(brainstormRoute(bs(null), NO_CHECK)).toBeNull();
        expect(brainstormRoute(null, NO_CHECK)).toBeNull();
        expect(composerBox(agent(), true, false, null)).toEqual(NORMAL_IDLE);
    });
    it("bash mode drops the route: the bash box, unrouted", () => {
        const box = composerBox(agent(), true, true, routed({ ...BS_FILE, done: false, question: Q5 }));
        expect(box).toEqual(composerBox(agent(), true, true));
    });
});

describe("sendRoutedLine", () => {
    const AGENT = agent({ id: "routed-agent", blockId: "blk-9" });
    const PATH = "/p/routed/brainstorm.json";
    const io = () => {
        const sent: [string, string][] = [];
        return {
            sent,
            prompt: async (blockId: string, text: string) => {
                sent.push([blockId, text]);
            },
            stopJudge: async () => {},
        };
    };
    const put = (file: BrainstormFile) =>
        globalStore.set(brainstormsAtom, { ...globalStore.get(brainstormsAtom), [AGENT.id]: bs(file, { path: PATH }) });
    const records = () => globalStore.get(brainstormAnswersAtom)[PATH] ?? [];

    it("a typed answer to question 5 sends the pane's answer line and records origin transcript", async () => {
        put({ ...BS_FILE, done: false, question: Q5 });
        const fake = io();
        await sendRoutedLine(AGENT, { kind: "talk", n: 5 }, "Its place\nin the queue", fake, 4000);
        expect(fake.sent).toEqual([["blk-9", "Its place in the queue"]]);
        expect(records().at(-1)).toEqual({
            line: "Its place in the queue",
            question: 5,
            builder: null,
            answer: "Its place in the queue",
            origin: "transcript",
            at: 4000,
        });
    });
    it("a builder answer goes as the pane's builder answer line", async () => {
        put({ ...BS_FILE, check: { ...CHECKED, yours: [{ q: BUILDER_Q }] } });
        const fake = io();
        await sendRoutedLine(AGENT, { kind: "builder" }, "Only report.", fake, 5000);
        expect(fake.sent).toEqual([["blk-9", "brainstorm: builder answer: Only report."]]);
        expect(records().at(-1)).toMatchObject({ builder: BUILDER_Q, origin: "transcript" });
    });
    it("a pushback line goes as typed and records no answer", async () => {
        put(BS_FILE);
        const before = records().length;
        const fake = io();
        await sendRoutedLine(AGENT, { kind: "line", hint: true }, "Why daily?", fake, 6000);
        expect(fake.sent).toEqual([["blk-9", "Why daily?"]]);
        expect(records()).toHaveLength(before);
    });
});

describe("contextRing", () => {
    it("is absent with no reported context", () => {
        expect(contextRing(undefined)).toBeNull();
        expect(contextRing({})).toBeNull();
    });
    it("rounds the percent, clamps the arc and titles with tokens only when the window size is known", () => {
        const known = contextRing({ contextpct: 6.4, contextmax: 1_000_000 });
        expect(known?.pct).toBe(6);
        expect(known?.title).toContain("6");
        expect(known?.title).toContain("1M");
        const unknown = contextRing({ contextpct: 140 });
        expect(unknown?.pct).toBe(140);
        expect(unknown?.arc).toBe(1);
        expect(unknown?.title).not.toContain("tokens");
    });
});

describe("toggleViewMode", () => {
    it("flips the mode, and a flipped agent goes back to rendered with the flip cleared", () => {
        const id = "toggle-agent";
        expect(globalStore.get(viewModeAtom(id))).toBe("terminal");
        toggleViewMode(id);
        expect(globalStore.get(viewModeAtom(id))).toBe("rendered");
        globalStore.set(pickerFlipAtom(id), 50);
        toggleViewMode(id);
        expect(globalStore.get(pickerFlipAtom(id))).toBeNull();
        expect(globalStore.get(viewModeAtom(id))).toBe("rendered");
        toggleViewMode(id);
        expect(globalStore.get(viewModeAtom(id))).toBe("terminal");
    });
});
