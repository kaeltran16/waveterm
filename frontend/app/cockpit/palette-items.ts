// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The universal search's rows, one builder per source. Each takes its data plus the callbacks its rows
// need (PaletteDeps), so command-palette.tsx only wires sources to builders and the rows' words are tested
// here. The grouping and ranking rules stay in palette-groups / palette-match.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import type { Binding, SurfaceKey } from "@/app/store/keybindings/types";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge, type AgentVM } from "@/app/view/agents/agentsviewmodel";
import { answerAgentAsk } from "@/app/view/agents/askanswer";
import { sendChannelMessage } from "@/app/view/agents/channelactions";
import { docReviewAtom } from "@/app/view/agents/docreview";
import type { Runtime } from "@/app/view/agents/launch";
import { channelProjectLabel } from "@/app/view/agents/projectlabel";
import { rowsWithChannel, type ProjectRow } from "@/app/view/agents/projectsstore";
import { runStatusView, type RunStatusTone } from "@/app/view/agents/runmodel";
import { openRunDag } from "@/app/view/agents/runrailsections";
import { openSessionHit } from "@/app/view/agents/sessionsfind";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
import { rankBriefRows, type BriefRow } from "@/app/view/jarvis/briefpalette";
import { workOnInitiative } from "@/app/view/jarvis/initiativeworkaction";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import { openAddress, openTarget } from "@/app/view/jarvis/openref";
import { fireAndForget } from "@/util/util";
import type { PrimitiveAtom } from "jotai";
import { Eye, Flag, GitFork, Plus, SlidersHorizontal, SquareTerminal, type LucideIcon } from "lucide-react";
import { errorText, runPaletteAction } from "./palette-action";
import {
    buildCommandItems,
    buildExtraItems,
    buildThemeItems,
    GOTO_GROUP,
    postCloseContext,
    START_BINDINGS,
    START_DEFS,
    type StartId,
} from "./palette-commands";
import type { ProjectRun } from "./palette-data";
import { buildLaunchItems, type LaunchDeps } from "./palette-launch";
import { rankPaletteItems } from "./palette-match";
import { inlineSelections, needsTarget, type NeedsGroup, type NeedsRow, type NeedsTarget } from "./palette-needs";
import { draftOf, NEW_NOTE_KEY, newDraft, noteDayLabel, noteKey, noteMarkdown, type NoteDraft } from "./palette-notes";
import type { PaletteItem, StatusTone } from "./palette-rows";
import {
    DRILL_LABELS,
    openDrill,
    parseProjectLaunch,
    pickScope,
    resolveChannelToken,
    type DrillId,
    type NavState,
} from "./palette-scope";

// what a row's run needs from the palette; every builder takes the one shape and uses what it needs
export interface PaletteDeps {
    model: AgentsViewModel;
    close: () => void;
    setNav: (next: NavState | ((s: NavState) => NavState)) => void;
    setSel: (sel: number) => void;
    setPaletteError: (error: string | undefined) => void;
}

export type CommandRow = PaletteItem & { group: string };

const START_ICONS: Record<StartId, LucideIcon> = { run: SlidersHorizontal, agent: SquareTerminal, initiative: Flag };

// the attention kind as the one word a Needs you row's status shows
const NEEDS_STATUS: Record<string, string> = {
    ask: "asking",
    escalation: "escalated",
    "dag-blocked": "blocked",
    "run-land-held": "land held",
    "run-unverified": "unverified",
};

export function themeRows(themePreset: string, { close }: PaletteDeps): PaletteItem[] {
    return buildThemeItems(themePreset).map((t) => ({
        key: t.key,
        kind: "theme" as const,
        search: t.title,
        title: t.title,
        meta: t.current ? "current" : undefined,
        swatch: t.swatch,
        verb: "Apply",
        echo: t.current ? "Already the theme" : `Switches the theme to ${t.title}, dropping per-role overrides`,
        run: () => {
            // matches selectPreset in settingssurface.tsx: picking a preset drops per-role overrides
            globalStore.set(themePresetAtom, t.id);
            globalStore.set(themeOverridesAtom, {});
            close();
        },
    }));
}

// Registry-derived: the "Go to" bindings are the surfaces, everything else is a command.
export function commandRows(
    bindings: Binding[],
    surface: SurfaceKey,
    themeCount: number,
    { model, close, setNav }: PaletteDeps
): { gotoItems: PaletteItem[]; commandItems: CommandRow[] } {
    const drillMeta: Record<DrillId, string> = {
        theme: `${themeCount} themes ›`,
    };
    const all = [
        ...buildCommandItems(bindings, postCloseContext(surface)),
        ...buildExtraItems({ openNewProject: () => globalStore.set(model.newProjectOpenAtom, true) }),
    ];
    const gotoItems: PaletteItem[] = all
        .filter((c) => c.group === GOTO_GROUP)
        .map((c) => ({
            key: c.key,
            kind: "surface" as const,
            search: c.title,
            title: c.title,
            chord: c.keys,
            verb: "Go to",
            echo: `Goes to ${c.title}`,
            run: () => {
                c.run();
                close();
            },
        }));
    const commandItems: CommandRow[] = all
        .filter((c) => c.group !== GOTO_GROUP && !START_BINDINGS.has(c.key))
        .map((c) => {
            const drill = c.drill;
            return {
                key: c.key,
                kind: "command" as const,
                group: c.group,
                search: `${c.title} ${c.group}`,
                title: c.title,
                chord: c.keys,
                meta: drill != null ? drillMeta[drill] : undefined,
                verb: drill != null ? "Pick" : "Run",
                echo: drill != null ? `Opens the ${DRILL_LABELS[drill].toLowerCase()} picker` : `Runs “${c.title}”`,
                run:
                    drill != null
                        ? () => setNav((s) => openDrill(s, drill))
                        : () => {
                              c.run();
                              close();
                          },
            };
        });
    return { gotoItems, commandItems };
}

export function startRows(bindings: Binding[], { model, close }: PaletteDeps): PaletteItem[] {
    const opens: Record<StartId, PrimitiveAtom<boolean>> = {
        run: model.newRunOpenAtom,
        agent: model.newAgentOpenAtom,
        initiative: model.newInitiativeOpenAtom,
    };
    return START_DEFS.map((d) => ({
        key: `start:${d.id}`,
        kind: "start" as const,
        search: d.title,
        title: d.title,
        icon: START_ICONS[d.id],
        meta: d.meta,
        chord: bindings.find((b) => b.id === d.binding && b.group === "Global")?.keys,
        verb: "Open",
        echo: d.echo,
        run: () => {
            close();
            globalStore.set(opens[d.id], true);
        },
    }));
}

export function agentRows(agents: AgentVM[], { model, close }: PaletteDeps): PaletteItem[] {
    return agents.map((a) => {
        const asking = a.state === "asking";
        return {
            key: `agent:${a.id}`,
            kind: "agent" as const,
            search: `${a.name} ${a.task ?? ""} ${a.project ?? ""}`,
            title: a.task ? `${a.name} — ${a.task}` : a.name,
            // the one thing the dropped preview pane earned: what an asking agent wants to know
            sub: asking ? a.ask?.questions?.[0]?.question : undefined,
            status: { label: a.state, tone: asking ? "asking" : a.state === "working" ? "working" : "muted" },
            verb: asking ? "Answer" : "Open",
            echo: asking ? `Opens ${a.name}’s terminal at its question` : `Opens ${a.name}’s terminal`,
            run: () => {
                model.openTerminal(a.id);
                close();
            },
        };
    });
}

function runTone(tone: RunStatusTone): StatusTone {
    if (tone === "running") {
        return "working";
    }
    return tone === "review" || tone === "blocked" ? "asking" : "muted";
}

// A run's status is its lifecycle word unless it is executing, where the phase count says more.
function runStatusLabel(r: Run, label: string): string {
    if (r.status !== "executing" || !r.phases?.length) {
        return label;
    }
    return `${r.phases.filter((p) => p.state === "done").length}/${r.phases.length}`;
}

// every project's runs, so each row names its project
export function runRows(
    runs: ProjectRun[],
    channels: Channel[] | null,
    projects: Record<string, ProjectKeywords>,
    { model, close }: PaletteDeps
): PaletteItem[] {
    const labels = new Map((channels ?? []).map((c) => [c.oid, channelProjectLabel(c, projects)]));
    return runs.map(({ channelId, run: r }) => {
        const view = runStatusView(r.status);
        const title = r.goal || "(untitled run)";
        const label = labels.get(channelId);
        return {
            key: `run:${r.id}`,
            kind: "run" as const,
            search: title,
            title,
            status: { label: runStatusLabel(r, view.label), tone: runTone(view.tone) },
            meta: label ? `#${label}` : undefined,
            verb: "Open",
            echo: "Opens the run in Jarvis",
            run: () => {
                fireAndForget(() => openTarget(model, { kind: "run", runId: r.id }));
                close();
            },
        };
    });
}

function needsIcon(row: NeedsRow): LucideIcon {
    if (row.agent == null) {
        return GitFork;
    }
    return row.review ? Eye : SquareTerminal;
}

function needsEcho(row: NeedsRow, t: NeedsTarget | null): string {
    const name = row.agent?.name ?? "";
    switch (t?.kind) {
        case "agent":
            return `Opens ${name}’s terminal at its question`;
        case "review":
            return `Opens ${name}’s review`;
        case "dag":
            return "Opens the run’s task graph";
        case "run":
            return "Opens the run in Jarvis";
        case "channel":
            return row.item.channelname ? `Opens #${row.item.channelname} in Jarvis` : "Opens its project in Jarvis";
        default:
            return "Nothing to open from here";
    }
}

// Enter's landing for a Needs you row; an item that names nowhere keeps the palette open
function openNeeds(t: NeedsTarget | null, { model, close }: PaletteDeps) {
    switch (t?.kind) {
        case "agent":
            model.openTerminal(t.agentId);
            break;
        case "review":
            // as the Agent surface's Review binding: the agent, with its review dialog open
            model.openTerminal(t.agentId);
            globalStore.set(docReviewAtom, t.agentId);
            break;
        case "dag":
            // openRunDag reads only the dag's oid off the run's dag
            openRunDag(
                model,
                {
                    runId: t.runId,
                    channelId: t.channelId,
                    title: "",
                    project: "",
                    dag: { oid: t.dagId } as TaskGroup,
                },
                t.taskId
            );
            break;
        case "run":
            fireAndForget(() => openTarget(model, { kind: "channel", channelId: t.channelId, runId: t.runId }));
            break;
        case "channel":
            fireAndForget(() => openTarget(model, { kind: "channel", channelId: t.channelId }));
            break;
        default:
            return;
    }
    close();
}

// In the Needs you scope Enter opens a row and digits answer it. On All's empty screen typed digits are
// query text, so an ask with options answers by first going to the scope with that ask selected.
export function needsPaletteRows(
    grouped: { group: NeedsGroup; rows: NeedsRow[] }[],
    deps: PaletteDeps
): { inScope: PaletteItem[]; inAll: PaletteItem[] } {
    const { setNav, setSel } = deps;
    const order = grouped.flatMap((g) => g.rows);
    const item = (row: NeedsRow): PaletteItem => {
        const a = row.agent;
        const t = needsTarget(row);
        const title = a != null ? (a.task ? `${a.name} — ${a.task}` : a.name) : row.item.text;
        const sub = a != null ? a.ask?.questions?.[0]?.question?.split("\n")[0] : row.item.source;
        const meta = row.item.channelname ? `#${row.item.channelname}` : undefined;
        return {
            key: `needs:${row.item.key}`,
            kind: "needs" as const,
            search: [title, sub, meta].filter(Boolean).join(" "),
            title,
            sub: sub || undefined,
            icon: needsIcon(row),
            status: { label: row.review ? "review" : (NEEDS_STATUS[row.item.kind] ?? "waiting"), tone: "asking" },
            meta,
            verb: row.review ? "Review" : "Open",
            echo: needsEcho(row, t),
            run: () => openNeeds(t, deps),
        };
    };
    const inScope = order.map(item);
    const inAll = order.map((row, idx): PaletteItem => {
        const base = inScope[idx];
        if (row.options.length === 0) {
            return base;
        }
        return {
            ...base,
            verb: "Answer",
            echo: `Shows ${row.agent!.name}’s options here, so you answer without leaving`,
            run: () => {
                // the scope lists the same rows in the same order, so the ask keeps its index
                setNav((s) => pickScope(s, "needs"));
                setSel(idx);
            },
            alt: { echo: `Opens ${row.agent!.name}’s terminal at the question instead`, run: base.run },
        };
    });
    return { inScope, inAll };
}

// The selected Needs you ask's options, as rows under it. A digit answers through the Cockpit's own send;
// one it cannot send opens the agent at its question rather than guessing.
export function answerRows(answering: NeedsRow | undefined, { model, close }: PaletteDeps): PaletteItem[] {
    const answer = (row: NeedsRow, digit: number) => {
        const agentId = row.agent!.id;
        const selections = inlineSelections(row, digit - 1);
        if (selections == null || !answerAgentAsk(model, agentId, selections, {})) {
            model.openTerminal(agentId);
        }
        close();
    };
    return (answering?.options ?? []).map((label, i) => ({
        key: `answer:${answering!.item.key}:${i + 1}`,
        kind: "answer" as const,
        search: "",
        title: label,
        digit: i + 1,
        verb: "Answer",
        echo: `Answers ${answering!.agent!.name}: “${label}”`,
        run: () => answer(answering!, i + 1),
    }));
}

export function sessionRows(sessions: SessionActivity[] | null, { model, close }: PaletteDeps): PaletteItem[] {
    const now = Date.now();
    return (sessions ?? [])
        .filter((s) => s.resumecommand)
        .map((s) => {
            const title = s.task || "(untitled session)";
            return {
                key: `session:${s.runtime}:${s.id}`,
                kind: "session" as const,
                search: `${s.task} ${s.projectname} ${s.branch}`,
                title,
                meta: `${s.runtime} · ${formatAge(now - s.lastactivets)}`,
                verb: "Resume",
                echo: `Resumes “${title}” in a new ${s.runtime} tab`,
                run: () => {
                    const piResume =
                        s.runtime === "pi" && s.resumeargs?.length
                            ? { startupArgs: s.resumeargs, resumePath: s.transcriptpath }
                            : {};
                    fireAndForget(() =>
                        launchAgent(model, {
                            runtime: s.runtime as Runtime,
                            startupCommand: s.resumecommand!,
                            task: "",
                            projectPath: s.projectpath,
                            projectName: s.projectname || "agent",
                            ...piResume,
                        })
                    );
                    close();
                },
            };
        });
}

// below this many non-space characters the Sessions scope ranks its archive titles instead of searching
const SESSION_QUERY_MIN = 2;

export function searchesSessions(query: string): boolean {
    return query.replace(/\s/g, "").length >= SESSION_QUERY_MIN;
}

// The Sessions scope's rows for a query: the server matched what was said, so they keep its order and every
// session lists, resumable or not. Enter opens it at its first hit; query and terms are the answered search's.
export function sessionSearchRows(
    results: SessionSearchResult[],
    query: string,
    terms: string[],
    { model, close }: PaletteDeps
): PaletteItem[] {
    const now = Date.now();
    return results.map((r) => {
        const s = r.session;
        const title = s.task || "(untitled session)";
        return {
            key: `session:${s.runtime}:${s.id}`,
            kind: "session" as const,
            search: title,
            title,
            sub: r.hits?.[0]?.text,
            meta: `${s.runtime} · ${formatAge(now - s.lastactivets)}`,
            verb: "Open",
            echo: `Opens “${title}” in Sessions at its first match`,
            run: () => {
                openSessionHit(model, r, query, terms);
                close();
            },
        };
    });
}

// Enter switches the active project and opens it.
export function channelRows(
    projectRows: ProjectRow[],
    active: Channel | null,
    { model, close }: PaletteDeps
): PaletteItem[] {
    return rowsWithChannel(projectRows).map(({ name, channel: c }) => {
        const current = c.oid === active?.oid;
        return {
            key: `channel:${c.oid}`,
            kind: "channel" as const,
            search: `#${name} ${c.projectpath ?? ""}`,
            title: `#${name}`,
            meta: current ? "current" : c.projectpath?.split(/[\\/]/).pop(),
            verb: "Switch",
            echo: current ? "Already the active project" : `Switches to #${name}`,
            run: () => {
                fireAndForget(() => openTarget(model, { kind: "channel", channelId: c.oid }));
                close();
            },
        };
    });
}

// Records and initiatives, archived ones included. briefpalette owns the index and the ranking (it sinks
// archived rows below every live one), so this only maps its rows onto palette rows, in its order:
// re-ranking here would undo the archived-last guarantee. Uncapped here — capGroups caps per group, the
// only place a cap cannot starve one kind to feed another.
export function briefRows(
    briefIndex: BriefRow[],
    query: string,
    efforts: EffortSummary[] | null,
    { model, close }: PaletteDeps
): PaletteItem[] {
    const now = Date.now();
    const open = (row: BriefRow) => {
        // an effort row's id is already an address
        fireAndForget(() => openAddress(model, row.kind === "record" ? `task:${row.id}` : row.id));
    };
    // a live initiative can also be worked on from here; an archived one is finished
    const workOn = (row: BriefRow): PaletteItem["alt"] => {
        const e = row.kind === "effort" && !row.archived ? efforts?.find((s) => s.oref === row.id) : undefined;
        if (e == null) {
            return undefined;
        }
        return {
            echo: "Works on it in a new agent, or goes to the one open on it",
            run: () => {
                void workOnInitiative(model, e);
                close();
            },
        };
    };
    return rankBriefRows(briefIndex, query, briefIndex.length).rows.map((r) => ({
        key: r.key,
        kind: r.kind, // BriefKind is a subset of GroupKind
        search: r.search,
        title: r.title,
        meta: [r.meta, r.ts > 0 ? formatAge(now - r.ts) : ""].filter(Boolean).join(" · ") || undefined,
        archived: r.archived,
        verb: "Open",
        echo: r.kind === "record" ? "Opens the record" : "Opens the initiative",
        run: () => {
            open(r);
            close();
        },
        alt: workOn(r),
    }));
}

// the Notes scope's rows: the server's order (newest first) until text is typed, then ranked by title
export function notesFor(rows: PaletteItem[], query: string): PaletteItem[] {
    return query.trim() === "" ? rows : rankPaletteItems(rows, query);
}

export function noteRows(
    notes: UserNote[] | null,
    openDraft: (d: NoteDraft) => void,
    { close, setPaletteError }: PaletteDeps
): PaletteItem[] {
    // the server names a note's day in local time, and en-CA writes a local date the same way
    const today = new Date().toLocaleDateString("en-CA");
    return (notes ?? []).map((n) => ({
        key: noteKey(n.id),
        kind: "note" as const,
        search: n.title,
        title: n.title,
        meta: noteDayLabel(n.day, today),
        verb: "Copy",
        echo: `Copies “${n.title}”`,
        alt: { echo: "Edits it", run: () => openDraft(draftOf(n)) },
        run: () => {
            setPaletteError(undefined);
            void runPaletteAction(() => navigator.clipboard.writeText(noteMarkdown(n))).then((result) => {
                if ("error" in result) {
                    setPaletteError(`Copy failed: ${errorText(result.error)}`);
                    return;
                }
                close();
            });
        },
    }));
}

// All has no preview pane, so Enter there shows the note where it can be read
export function notesInAll(noteItems: PaletteItem[], nav: NavState, { setNav, setSel }: PaletteDeps): PaletteItem[] {
    return noteItems.map(
        (it): PaletteItem => ({
            ...it,
            verb: "Show",
            echo: "Shows the note in Notes",
            alt: undefined, // the editor leaves to the Notes list, so it opens from there
            run: () => {
                // the scope ranks the same rows by the same text, so this is the note's index there
                const at = notesFor(noteItems, nav.query).findIndex((row) => row.key === it.key);
                setNav(pickScope(nav, "notes"));
                setSel(at);
            },
        })
    );
}

// "New note" closes the Notes list; typed text becomes its title
export function newNoteRow(query: string, openDraft: (d: NoteDraft) => void): PaletteItem {
    const q = query.trim();
    return {
        key: NEW_NOTE_KEY,
        kind: "note",
        search: "",
        title: "New note",
        icon: Plus,
        verb: "Write",
        echo: q === "" ? "Writes a new note" : `Writes a new note titled “${q}”`,
        run: () => openDraft(newDraft(query)),
    };
}

export interface LaunchTarget {
    projectLaunch: ReturnType<typeof parseProjectLaunch>;
    targetChannel: Channel | null;
    launchGoal: string;
    targetLabel: string;
    launchLabel: string; // "#name", or "a project" when there is none to guess
    unmatchedProject: boolean; // a "#name goal" naming no project
}

// Projects scope with "<project> <goal>" targets that project; everywhere else, the home one.
export function launchTarget(
    nav: NavState,
    channels: Channel[] | null,
    projects: Record<string, ProjectKeywords>,
    homeChannel: Channel | null
): LaunchTarget {
    const projectLaunch = nav.scope === "projects" && nav.drill == null ? parseProjectLaunch(nav.query) : null;
    const pickedChannel = projectLaunch
        ? (resolveChannelToken(
              projectLaunch.token,
              (channels ?? []).map((c) => ({ c, name: channelProjectLabel(c, projects) }))
          )?.c ?? null)
        : null;
    const targetChannel = projectLaunch ? pickedChannel : homeChannel;
    const launchGoal = projectLaunch ? projectLaunch.goal : nav.scope === "all" ? nav.query : "";
    const targetLabel = targetChannel ? channelProjectLabel(targetChannel, projects) : "";
    return {
        projectLaunch,
        targetChannel,
        launchGoal,
        targetLabel,
        // no project to guess is not a dead end: the New run window asks for one
        launchLabel: targetLabel ? `#${targetLabel}` : "a project",
        // a "#name goal" naming no project shows that instead of offering to start somewhere else
        unmatchedProject: projectLaunch != null && pickedChannel == null,
    };
}

export function launchRows(
    launchGoal: string,
    unmatchedProject: boolean,
    targetChannel: Channel | null,
    agents: AgentVM[],
    projects: Record<string, ProjectKeywords>,
    { model, close, setPaletteError }: PaletteDeps
): PaletteItem[] {
    if (launchGoal.trim() === "" || unmatchedProject) {
        return [];
    }
    const ch = targetChannel;
    const projectName = ch ? channelProjectLabel(ch, projects) : "";
    // a failure keeps the goal in the palette and says why; success lands on the result, then closes
    const fireLaunch = (action: () => Promise<unknown>, land: () => void) => {
        setPaletteError(undefined);
        void runPaletteAction(action).then((result) => {
            if ("error" in result) {
                setPaletteError(`Launch failed: ${errorText(result.error)}`);
                return;
            }
            land();
            close();
        });
    };
    const deps: LaunchDeps = {
        // the window clears the prefill once its project list loads
        open: (goal, shape) => {
            globalStore.set(newRunPrefillAtom, { projectName, goal, shape });
            close();
            globalStore.set(model.newRunOpenAtom, true);
        },
        // only offered with a project; the user never types "ask @", the transport string is synthesized
        consult: (runtime, goal) =>
            fireLaunch(
                () =>
                    sendChannelMessage({
                        model,
                        channelId: ch!.oid,
                        projectPath: ch!.projectpath ?? "",
                        projectName: projectName || "agent",
                        roster: agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId })),
                        text: `ask @${runtime} ${goal}`,
                    }),
                () => globalStore.set(model.surfaceAtom, "jarvis")
            ),
    };
    return buildLaunchItems(launchGoal, projectName || undefined, deps).map((li) => ({
        key: li.key,
        kind: "launch" as const,
        search: "",
        title: li.title,
        desc: li.desc,
        launchIcon: li.icon,
        chord: li.chord,
        verb: li.verb,
        echo: li.echo,
        run: li.run,
        alt: li.alt,
    }));
}

export interface FooterLine {
    k: string;
    text: string;
    arm?: boolean; // the armed second press, in the warning tone
}

// The footer's key lines under Enter's echo: what else the selected row answers to. answering is the
// selected ask whose answer rows are showing.
export function footerLines(
    selected: PaletteItem | undefined,
    answering: NeedsRow | undefined,
    note: UserNote | undefined,
    armedDelete: boolean
): FooterLine[] {
    const answers = answering?.options.length ?? 0;
    return [
        ...(selected?.alt != null ? [{ k: "ctrl ⏎", text: selected.alt.echo }] : []),
        ...(answers > 0
            ? [{ k: answers === 1 ? "1" : `1–${answers}`, text: `Answers ${answering!.agent!.name} here` }]
            : []),
        ...(selected?.actions ? [{ k: "→", text: `Its ${selected.actions} actions` }] : []),
        ...(note != null
            ? [
                  armedDelete
                      ? { k: "del", text: `del again deletes “${note.title}”`, arm: true }
                      : { k: "del", text: "Deletes it, after a second del" },
              ]
            : []),
    ];
}
