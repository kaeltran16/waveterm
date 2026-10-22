// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/view/jarvis/openref", () => ({ openAddress: vi.fn(), openTarget: vi.fn() }));
vi.mock("@/app/cockpit/cockpit-actions", () => ({ launchAgent: vi.fn() }));
vi.mock("@/app/view/agents/askanswer", () => ({ answerAgentAsk: vi.fn() }));
vi.mock("@/app/view/agents/channelactions", () => ({ sendChannelMessage: vi.fn() }));
vi.mock("@/app/view/agents/runrailsections", () => ({ openRunDag: vi.fn() }));
vi.mock("@/app/view/jarvis/initiativeworkaction", () => ({ workOnInitiative: vi.fn() }));

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import type { Binding } from "@/app/store/keybindings/types";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { answerAgentAsk } from "@/app/view/agents/askanswer";
import { docReviewAtom } from "@/app/view/agents/docreview";
import { openRunDag } from "@/app/view/agents/runrailsections";
import { THEMES } from "@/app/view/agents/themes";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
import { buildBriefIndex } from "@/app/view/jarvis/briefpalette";
import { workOnInitiative } from "@/app/view/jarvis/initiativeworkaction";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import { openAddress, openTarget } from "@/app/view/jarvis/openref";
import { atom } from "jotai";
import {
    agentRows,
    answerRows,
    briefRows,
    channelRows,
    commandRows,
    footerLines,
    launchRows,
    launchTarget,
    needsPaletteRows,
    newNoteRow,
    noteRows,
    notesFor,
    notesInAll,
    runRows,
    sessionRows,
    startRows,
    themeRows,
    type PaletteDeps,
} from "./palette-items";
import { needsGroups, needsRows, type NeedsRow } from "./palette-needs";
import { NEW_NOTE_KEY } from "./palette-notes";
import type { PaletteItem } from "./palette-rows";
import { initialNav, type NavState } from "./palette-scope";

function fakeModel() {
    return {
        newProjectOpenAtom: atom(false),
        newRunOpenAtom: atom(false),
        newAgentOpenAtom: atom(false),
        newInitiativeOpenAtom: atom(false),
        surfaceAtom: atom("agent"),
        openTerminal: vi.fn(),
    } as unknown as AgentsViewModel;
}

let deps: PaletteDeps & { close: ReturnType<typeof vi.fn>; setNav: ReturnType<typeof vi.fn> };
let setSel: ReturnType<typeof vi.fn>;
let setPaletteError: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    setSel = vi.fn();
    setPaletteError = vi.fn();
    deps = { model: fakeModel(), close: vi.fn(), setNav: vi.fn(), setSel, setPaletteError };
});

// the state setNav was handed, applied to a starting nav
function navAfter(from: NavState): NavState {
    const arg = deps.setNav.mock.calls.at(-1)![0];
    return typeof arg === "function" ? arg(from) : arg;
}

const nav = (over: Partial<NavState> = {}): NavState => ({ ...initialNav("agent"), ...over });
const agent = (over: Partial<AgentVM>) =>
    ({ id: "a1", name: "juno", state: "idle", blockId: "b1", ...over }) as AgentVM;
const channel = (oid: string, projectpath: string, name = "") => ({ oid, projectpath, name }) as Channel;
const projects = { waveterm: { path: "C:/src/waveterm" } } as Record<string, ProjectKeywords>;

describe("themeRows", () => {
    it("marks the current theme, and applying one drops per-role overrides", () => {
        const rows = themeRows(THEMES[0].id, deps);
        expect(rows[0]).toMatchObject({
            key: `theme:${THEMES[0].id}`,
            kind: "theme",
            title: THEMES[0].name,
            meta: "current",
            verb: "Apply",
            echo: "Already the theme",
        });
        const other = rows[1];
        expect(other.meta).toBeUndefined();
        expect(other.echo).toBe(`Switches the theme to ${THEMES[1].name}, dropping per-role overrides`);
        globalStore.set(themeOverridesAtom, { accent: "x" } as any);
        other.run();
        expect(globalStore.get(themePresetAtom)).toBe(THEMES[1].id);
        expect(globalStore.get(themeOverridesAtom)).toEqual({});
        expect(deps.close).toHaveBeenCalled();
    });
});

describe("commandRows", () => {
    const bind = (over: Partial<Binding> & Pick<Binding, "id" | "label">): Binding => ({
        keys: "",
        group: "Global",
        run: vi.fn(),
        ...over,
    });

    it("splits the surfaces into Go to rows and the rest into commands, leaving Start's bindings out", () => {
        const gotoRun = vi.fn();
        const bindings = [
            bind({ id: "goto:usage", keys: "g u", label: "Usage", group: "Go to", run: gotoRun }),
            bind({ id: "toggle-rail", keys: "Ctrl:b", label: "Toggle rail", group: "View" }),
            bind({ id: "new-agent", keys: "Ctrl:n", label: "New agent" }),
        ];
        const { gotoItems, commandItems } = commandRows(bindings, "agent", 12, deps);
        expect(gotoItems).toHaveLength(1);
        expect(gotoItems[0]).toMatchObject({
            key: "goto:usage",
            kind: "surface",
            title: "Usage",
            chord: "g u",
            verb: "Go to",
            echo: "Goes to Usage",
        });
        gotoItems[0].run();
        expect(gotoRun).toHaveBeenCalled();
        expect(deps.close).toHaveBeenCalled();

        expect(commandItems.map((c) => c.key)).toEqual(["toggle-rail", "cmd:new-project", "cmd:theme"]);
        expect(commandItems[0]).toMatchObject({
            kind: "command",
            group: "View",
            search: "Toggle rail View",
            verb: "Run",
            echo: "Runs “Toggle rail”",
            meta: undefined,
        });
    });

    it("lets the theme row drill into the picker, its meta counting the themes", () => {
        const { commandItems } = commandRows([], "agent", 12, deps);
        const theme = commandItems.find((c) => c.key === "cmd:theme")!;
        expect(theme).toMatchObject({ meta: "12 themes ›", verb: "Pick", echo: "Opens the theme picker" });
        theme.run();
        expect(navAfter(nav()).drill).toBe("theme");
        expect(deps.close).not.toHaveBeenCalled();
    });

    it("opens New project from its extra row", () => {
        const { commandItems } = commandRows([], "agent", 1, deps);
        commandItems.find((c) => c.key === "cmd:new-project")!.run();
        expect(globalStore.get(deps.model.newProjectOpenAtom)).toBe(true);
    });
});

describe("startRows", () => {
    it("takes a Global binding's chord and opens its window after closing", () => {
        const rows = startRows(
            [{ id: "new-agent", keys: "Ctrl:n", group: "Global", label: "New agent", run: () => {} }],
            deps
        );
        expect(rows.map((r) => r.key)).toEqual(["start:run", "start:agent", "start:initiative"]);
        expect(rows[1]).toMatchObject({
            kind: "start",
            title: "New agent…",
            chord: "Ctrl:n",
            verb: "Open",
            echo: "Opens the New agent window",
        });
        expect(rows[0].chord).toBeUndefined();
        expect(rows[0].meta).toBe("goal or plan file, workers, models");
        rows[1].run();
        expect(deps.close).toHaveBeenCalled();
        expect(globalStore.get(deps.model.newAgentOpenAtom)).toBe(true);
    });
});

describe("agentRows", () => {
    it("titles an agent with its task, and an asking one answers at its question", () => {
        const [idle, asking] = agentRows(
            [
                agent({ id: "a1", task: "fix the build", project: "waveterm" }),
                agent({ id: "a2", name: "vela", state: "asking", ask: { questions: [{ question: "Which?" }] } as any }),
            ],
            deps
        );
        expect(idle).toMatchObject({
            key: "agent:a1",
            kind: "agent",
            search: "juno fix the build waveterm",
            title: "juno — fix the build",
            sub: undefined,
            status: { label: "idle", tone: "muted" },
            verb: "Open",
            echo: "Opens juno’s terminal",
        });
        expect(asking).toMatchObject({
            title: "vela",
            sub: "Which?",
            status: { label: "asking", tone: "asking" },
            verb: "Answer",
            echo: "Opens vela’s terminal at its question",
        });
        asking.run();
        expect(deps.model.openTerminal).toHaveBeenCalledWith("a2");
        expect(deps.close).toHaveBeenCalled();
    });

    it("shows a working agent in the working tone", () => {
        expect(agentRows([agent({ state: "working" })], deps)[0].status).toEqual({ label: "working", tone: "working" });
    });
});

describe("runRows", () => {
    const run = (over: Partial<Run>) => ({ id: "r1", goal: "ship it", status: "done", ...over }) as Run;

    it("names each run's project, and shows an executing run's phase count", () => {
        const rows = runRows(
            [
                {
                    channelId: "c1",
                    run: run({
                        status: "executing",
                        phases: [{ state: "done" }, { state: "running" }] as any,
                    }),
                },
                { channelId: "gone", run: run({ id: "r2", goal: "", status: "blocked" }) },
            ],
            [channel("c1", "C:/src/waveterm")],
            projects,
            deps
        );
        expect(rows[0]).toMatchObject({
            key: "run:r1",
            kind: "run",
            title: "ship it",
            status: { label: "1/2", tone: "working" },
            meta: "#waveterm",
            verb: "Open",
            echo: "Opens the run in Jarvis",
        });
        expect(rows[1]).toMatchObject({ title: "(untitled run)", status: { label: "blocked", tone: "asking" } });
        expect(rows[1].meta).toBeUndefined();
        rows[0].run();
        expect(vi.mocked(openTarget).mock.calls[0][1]).toEqual({ kind: "run", runId: "r1" });
        expect(deps.close).toHaveBeenCalled();
    });

    it("shows a finished run's lifecycle word, muted", () => {
        const [r] = runRows([{ channelId: "c1", run: run({}) }], [], {}, deps);
        expect(r.status).toEqual({ label: "done", tone: "muted" });
    });
});

describe("needsPaletteRows", () => {
    const item = (over: Partial<AttentionItem>) =>
        ({ source: "", text: "", action: "", phaseidx: 0, waitingsince: 0, ...over }) as AttentionItem;
    const ask = { questions: [{ question: "Which one?\nmore", options: [{ label: "A" }, { label: "B" }] }] };
    const grouped = () =>
        needsGroups(
            needsRows(
                [
                    item({ kind: "ask", key: "ask:block:b1", channelname: "waveterm" }),
                    item({ kind: "dag-gate", key: "dag-gate:d1", text: "Gate", channelid: "c1", runid: "r1" }),
                ],
                [agent({ state: "asking", task: "fix", ask } as any)]
            )
        );

    it("words an ask and a gate, in group order", () => {
        const { inScope } = needsPaletteRows(grouped(), deps);
        expect(inScope.map((r) => r.key)).toEqual(["needs:ask:block:b1", "needs:dag-gate:d1"]);
        expect(inScope[0]).toMatchObject({
            kind: "needs",
            title: "juno — fix",
            sub: "Which one?",
            meta: "#waveterm",
            search: "juno — fix Which one? #waveterm",
            status: { label: "asking", tone: "asking" },
            verb: "Open",
            echo: "Opens juno’s terminal at its question",
        });
        expect(inScope[1]).toMatchObject({
            title: "Gate",
            status: { label: "gate", tone: "asking" },
            echo: "Opens the run’s task graph",
        });
        inScope[1].run();
        expect(vi.mocked(openRunDag).mock.calls[0][1]).toMatchObject({ runId: "r1", channelId: "c1" });
        expect(deps.close).toHaveBeenCalled();
    });

    it("in All, an ask with options answers by going to the scope with it selected", () => {
        const { inScope, inAll } = needsPaletteRows(grouped(), deps);
        expect(inAll[0]).toMatchObject({
            verb: "Answer",
            echo: "Shows juno’s options here, so you answer without leaving",
            alt: { echo: "Opens juno’s terminal at the question instead" },
        });
        expect(inAll[1]).toBe(inScope[1]);
        inAll[0].run();
        expect(navAfter(nav()).scope).toBe("needs");
        expect(setSel).toHaveBeenCalledWith(0);
        inAll[0].alt!.run();
        expect(deps.model.openTerminal).toHaveBeenCalledWith("a1");
    });

    it("opens a review with its dialog", () => {
        const review = {
            item: item({ kind: "ask", key: "ask:block:b1" }),
            group: "reviews",
            agent: agent({ id: "a1", state: "asking" }),
            review: true,
            options: [],
        } as NeedsRow;
        const [row] = needsPaletteRows([{ group: "reviews", rows: [review] }], deps).inScope;
        expect(row).toMatchObject({ verb: "Review", echo: "Opens juno’s review", status: { label: "review" } });
        row.run();
        expect(deps.model.openTerminal).toHaveBeenCalledWith("a1");
        expect(globalStore.get(docReviewAtom)).toBe("a1");
        expect(deps.close).toHaveBeenCalled();
    });

    it("keeps the palette open on an item that names nowhere", () => {
        const g = needsGroups(needsRows([item({ kind: "run-land-held", key: "k" })], []));
        const [row] = needsPaletteRows(g, deps).inScope;
        expect(row).toMatchObject({ echo: "Nothing to open from here", status: { label: "land held" } });
        row.run();
        expect(deps.close).not.toHaveBeenCalled();
    });
});

describe("answerRows", () => {
    const row = (options: string[]) =>
        ({ item: { key: "ask:block:b1" }, agent: agent({ id: "a1" }), options, review: false }) as unknown as NeedsRow;

    it("lists nothing without a selected ask", () => {
        expect(answerRows(undefined, deps)).toEqual([]);
    });

    it("numbers each option and answers through the cockpit's send", () => {
        vi.mocked(answerAgentAsk).mockReturnValue(true);
        const rows = answerRows(row(["Yes", "No"]), deps);
        expect(rows[1]).toMatchObject({
            key: "answer:ask:block:b1:2",
            kind: "answer",
            title: "No",
            digit: 2,
            verb: "Answer",
            echo: "Answers juno: “No”",
        });
        rows[1].run();
        expect(answerAgentAsk).toHaveBeenCalled();
        expect(deps.model.openTerminal).not.toHaveBeenCalled();
        expect(deps.close).toHaveBeenCalled();
    });

    it("opens the agent at its question when the answer cannot be sent", () => {
        vi.mocked(answerAgentAsk).mockReturnValue(false);
        answerRows(row(["Yes"]), deps)[0].run();
        expect(deps.model.openTerminal).toHaveBeenCalledWith("a1");
    });
});

describe("sessionRows", () => {
    afterEach(() => vi.useRealTimers());

    it("lists only resumable sessions and resumes one in a new tab", () => {
        vi.useFakeTimers();
        vi.setSystemTime(10 * 3_600_000);
        const s = (over: Partial<SessionActivity>) =>
            ({
                id: "s1",
                runtime: "claude",
                task: "refactor",
                projectname: "waveterm",
                projectpath: "C:/src/waveterm",
                branch: "main",
                lastactivets: 8 * 3_600_000,
                resumecommand: "claude --resume s1",
                ...over,
            }) as SessionActivity;
        const rows = sessionRows([s({}), s({ id: "s2", resumecommand: "" })], deps);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            key: "session:claude:s1",
            kind: "session",
            search: "refactor waveterm main",
            title: "refactor",
            meta: "claude · 2h",
            verb: "Resume",
            echo: "Resumes “refactor” in a new claude tab",
        });
        rows[0].run();
        expect(vi.mocked(launchAgent).mock.calls[0][1]).toMatchObject({
            runtime: "claude",
            startupCommand: "claude --resume s1",
            projectName: "waveterm",
        });
        expect(deps.close).toHaveBeenCalled();
    });
});

describe("channelRows", () => {
    it("marks the active project and switches to another", () => {
        const a = channel("c1", "C:/src/waveterm");
        const b = channel("c2", "C:/src/other");
        const rows = channelRows(
            [
                { name: "waveterm", path: "C:/src/waveterm", channel: a },
                { name: "other", path: "C:/src/other", channel: b },
                { name: "unloaded", path: "C:/src/x" },
            ],
            a,
            deps
        );
        expect(rows.map((r) => r.key)).toEqual(["channel:c1", "channel:c2"]);
        expect(rows[0]).toMatchObject({ title: "#waveterm", meta: "current", echo: "Already the active project" });
        expect(rows[1]).toMatchObject({
            kind: "channel",
            search: "#other C:/src/other",
            meta: "other",
            verb: "Switch",
            echo: "Switches to #other",
        });
        rows[1].run();
        expect(vi.mocked(openTarget).mock.calls[0][1]).toEqual({ kind: "channel", channelId: "c2" });
    });
});

describe("briefRows", () => {
    const effort = (over: Partial<EffortSummary>) =>
        ({
            oref: "effort:e1",
            title: "Palette",
            status: "active",
            total: 4,
            done: 1,
            updatedts: 0,
            ...over,
        }) as EffortSummary;
    const record = { id: "t1", objective: "A record", status: "open", ticket: "", updated: 0 } as SpaceSummary;

    it("opens a record by its task address, and an initiative by its oref, with work-on as alt", () => {
        const live = effort({});
        const rows = briefRows(buildBriefIndex({ records: [record], efforts: [live] }), "", [live], deps);
        const rec = rows.find((r) => r.key === "record:t1")!;
        const ini = rows.find((r) => r.key === "effort:effort:e1")!;
        expect(rec).toMatchObject({
            kind: "record",
            title: "A record",
            meta: "open",
            archived: false,
            verb: "Open",
            echo: "Opens the record",
            alt: undefined,
        });
        expect(ini).toMatchObject({
            kind: "effort",
            meta: "active · 1/4",
            echo: "Opens the initiative",
            alt: { echo: "Works on it in a new agent, or goes to the one open on it" },
        });
        rec.run();
        expect(vi.mocked(openAddress).mock.calls[0][1]).toBe("task:t1");
        ini.run();
        expect(vi.mocked(openAddress).mock.calls[1][1]).toBe("effort:e1");
        ini.alt!.run();
        expect(workOnInitiative).toHaveBeenCalledWith(deps.model, live);
        expect(deps.close).toHaveBeenCalledTimes(3);
    });

    it("offers no work-on for an archived initiative", () => {
        const done = effort({ status: "archived" });
        const [row] = briefRows(buildBriefIndex({ efforts: [done] }), "", [done], deps);
        expect(row).toMatchObject({ archived: true, alt: undefined });
    });
});

describe("notes", () => {
    const note = (id: string, title: string) => ({ id, title, day: "2026-10-08" }) as UserNote;
    const openDraft = vi.fn();

    it("copies a note on Enter and edits it on Ctrl+Enter", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const [row] = noteRows([note("n1", "Build steps")], openDraft, deps);
        expect(row).toMatchObject({
            key: "note:n1",
            kind: "note",
            title: "Build steps",
            verb: "Copy",
            echo: "Copies “Build steps”",
            alt: { echo: "Edits it" },
        });
        expect(row.meta).toBeTruthy();
        row.run();
        await vi.waitFor(() => expect(deps.close).toHaveBeenCalled());
        expect(writeText).toHaveBeenCalled();
        row.alt!.run();
        expect(openDraft).toHaveBeenCalledWith(expect.objectContaining({ id: "n1", title: "Build steps" }));
        vi.unstubAllGlobals();
    });

    it("keeps the palette open on a failed copy and says why", async () => {
        vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
        noteRows([note("n1", "x")], openDraft, deps)[0].run();
        await vi.waitFor(() => expect(setPaletteError).toHaveBeenCalledWith("Copy failed: denied"));
        expect(deps.close).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("in All, shows the note in the Notes scope at its index there", () => {
        const rows = noteRows([note("n1", "alpha"), note("n2", "beta")], openDraft, deps);
        const start = nav({ query: "beta" });
        const inAll = notesInAll(rows, start, deps);
        expect(inAll[1]).toMatchObject({
            key: "note:n2",
            verb: "Show",
            echo: "Shows the note in Notes",
            alt: undefined,
        });
        inAll[1].run();
        expect(navAfter(start).scope).toBe("notes");
        expect(setSel).toHaveBeenCalledWith(notesFor(rows, "beta").findIndex((r) => r.key === "note:n2"));
    });

    it("keeps the server order until text is typed", () => {
        const rows = noteRows([note("n1", "zeta"), note("n2", "alpha")], openDraft, deps);
        expect(notesFor(rows, " ").map((r) => r.key)).toEqual(["note:n1", "note:n2"]);
    });

    it("titles a new note with the typed text", () => {
        expect(newNoteRow("", openDraft)).toMatchObject({
            key: NEW_NOTE_KEY,
            verb: "Write",
            echo: "Writes a new note",
        });
        const row = newNoteRow(" todo ", openDraft);
        expect(row.echo).toBe("Writes a new note titled “todo”");
        row.run();
        expect(openDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "todo" }));
    });
});

describe("launch", () => {
    const home = channel("c1", "C:/src/waveterm");
    const chans = [home, channel("c2", "C:/src/other", "other")];

    it("targets the home project from All, with the query as the goal", () => {
        const t = launchTarget(nav({ query: "fix it" }), chans, projects, home);
        expect(t).toMatchObject({
            projectLaunch: null,
            targetChannel: home,
            launchGoal: "fix it",
            targetLabel: "waveterm",
            launchLabel: "#waveterm",
            unmatchedProject: false,
        });
    });

    it("targets a named project from Projects, and says when the name matches none", () => {
        const picked = launchTarget(nav({ scope: "projects", query: "other do it" }), chans, projects, home);
        expect(picked).toMatchObject({ targetChannel: chans[1], launchGoal: "do it", launchLabel: "#other" });
        const none = launchTarget(nav({ scope: "projects", query: "nope do it" }), chans, projects, home);
        expect(none).toMatchObject({ targetChannel: null, launchLabel: "a project", unmatchedProject: true });
    });

    it("offers no goal outside All and Projects", () => {
        expect(launchTarget(nav({ scope: "runs", query: "x" }), chans, projects, home).launchGoal).toBe("");
    });

    it("builds the launch rows, and Quick opens New run prefilled", () => {
        const rows = launchRows("fix it", false, home, [], projects, deps);
        expect(rows[0]).toMatchObject({
            key: "launch:quick",
            kind: "launch",
            search: "",
            title: "Quick",
            verb: "Open",
        });
        expect(rows.every((r) => r.launchIcon != null && r.desc != null)).toBe(true);
        rows[0].run();
        expect(globalStore.get(newRunPrefillAtom)).toMatchObject({ projectName: "waveterm", goal: "fix it" });
        expect(globalStore.get(deps.model.newRunOpenAtom)).toBe(true);
        expect(deps.close).toHaveBeenCalled();
    });

    it("builds nothing for an empty goal or an unmatched project", () => {
        expect(launchRows(" ", false, home, [], projects, deps)).toEqual([]);
        expect(launchRows("x", true, null, [], projects, deps)).toEqual([]);
    });
});

describe("footerLines", () => {
    const item = (over: Partial<PaletteItem>): PaletteItem => ({
        key: "k",
        kind: "agent",
        search: "",
        title: "t",
        verb: "Open",
        echo: "e",
        run: () => {},
        ...over,
    });

    it("lists nothing for a plain row", () => {
        expect(footerLines(item({}), undefined, undefined, false)).toEqual([]);
    });

    it("lists the alt, the answer digits, the actions and the delete, in that order", () => {
        const answering = { agent: agent({ name: "juno" }), options: ["a", "b"] } as unknown as NeedsRow;
        const note = { id: "n1", title: "Steps", day: "" } as UserNote;
        const lines = footerLines(item({ alt: { echo: "Other", run: () => {} }, actions: 3 }), answering, note, false);
        expect(lines).toEqual([
            { k: "ctrl ⏎", text: "Other" },
            { k: "1–2", text: "Answers juno here" },
            { k: "→", text: "Its 3 actions" },
            { k: "del", text: "Deletes it, after a second del" },
        ]);
    });

    it("names a single answer by its digit, and an armed delete by the note", () => {
        const answering = { agent: agent({ name: "juno" }), options: ["a"] } as unknown as NeedsRow;
        const note = { id: "n1", title: "Steps", day: "" } as UserNote;
        expect(footerLines(item({}), answering, note, true)).toEqual([
            { k: "1", text: "Answers juno here" },
            { k: "del", text: "del again deletes “Steps”", arm: true },
        ]);
    });
});
