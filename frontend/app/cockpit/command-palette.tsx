// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The universal search — Ctrl+P on every surface. One overlay with visible scopes (All, Go to, Agents,
// Runs, Sessions, Records, Projects, Files, Commands): Tab walks them, and the old sigils still work
// by becoming the chip. In All, text that names something opens it and text that names nothing is a
// goal the launch rows start. Code's own file finder folded in as the Files scope, preselected there.
// This is the ONE palette: a new findable kind is a new entry source here, never a second overlay or a
// second shortcut. The rules live in the pure palette-*.ts modules; this file wires sources to them.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import { bindingsAtom } from "@/app/store/keybindings/store";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { sendChannelMessage } from "@/app/view/agents/channelactions";
import { activeChannelAtom, activeChannelRunsAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { activeFocusAtom, enterFocusFor, exitFocus, focusesAtom, loadFocuses } from "@/app/view/agents/focusstore";
import type { Runtime } from "@/app/view/agents/launch";
import { channelProjectLabel, dedupeByProject } from "@/app/view/agents/projectlabel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { createRun, resolveChannelLaunchRoute } from "@/app/view/agents/runactions";
import { runStatusView, type RunStatusTone } from "@/app/view/agents/runmodel";
import { loadSessionsArchive, sessionsArchiveAtom } from "@/app/view/agents/sessionsarchivestore";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
import { recentPaths } from "@/app/view/code/codehistory";
import {
    codeHistoryAtom,
    codeIndexAtom,
    codePendingLineAtom,
    codeProjectAtom,
    loadFileIndex,
    openInCode,
    type CodeIndex,
} from "@/app/view/code/codestore";
import { buildBriefIndex, rankBriefRows, type BriefRow } from "@/app/view/jarvis/briefpalette";
import { openAddress, openTarget } from "@/app/view/jarvis/openref";
import { taskListAtom } from "@/app/view/jarvis/tasksstore";
import { sameRepoPath } from "@/util/paths";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { runPaletteAction } from "./palette-action";
import {
    buildCommandItems,
    buildExtraItems,
    buildThemeItems,
    commandGroups,
    GOTO_GROUP,
    postCloseContext,
} from "./palette-commands";
import { loadPaletteEntities, mergeRanked, paletteEffortsAtom } from "./palette-entities";
import { assembleFileGroups, fileEcho } from "./palette-files";
import { buildFocusItems } from "./palette-focus";
import {
    ALL_KIND_ORDER,
    assembleAllGroups,
    assembleScopeGroups,
    capGroups,
    MAX_IN_ALL,
    MAX_IN_SCOPE,
    type GroupKind,
    type PaletteGroup,
} from "./palette-groups";
import { buildLaunchItems, type LaunchDeps } from "./palette-launch";
import { rankPaletteItems } from "./palette-match";
import { MAX_RECENT, nextMru, paletteMruAtom, recentItems, sortByMru } from "./palette-mru";
import { PaletteGroupView, type PaletteItem, type StatusTone } from "./palette-rows";
import {
    backspaceEmpty,
    cycleScope,
    DRILL_LABELS,
    DRILL_PLACEHOLDERS,
    initialNav,
    openDrill,
    parseProjectLaunch,
    pickScope,
    resolveChannelToken,
    scopeDef,
    SCOPES,
    typeQuery,
    type DrillId,
    type NavState,
    type ScopeId,
} from "./palette-scope";

type CommandRow = PaletteItem & { group: string };

// the kinds each narrowed scope lists, in the order its groups show
const SCOPE_KINDS: Partial<Record<ScopeId, GroupKind[]>> = {
    goto: ["surface"],
    agents: ["agent"],
    runs: ["run"],
    sessions: ["session"],
    records: ["record", "effort"],
    projects: ["channel"],
};

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

export function CommandPalette({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(model.paletteOpenAtom);
    const agents = useAtomValue(model.agentsAtom);
    const sessions = useAtomValue(sessionsArchiveAtom);
    const channel = useAtomValue(activeChannelAtom);
    const channels = useAtomValue(channelsAtom);
    const runs = useAtomValue(activeChannelRunsAtom);
    const projects = useAtomValue(projectsAtom);
    const spaces = useAtomValue(focusesAtom);
    const activeSpace = useAtomValue(activeFocusAtom);
    const records = useAtomValue(taskListAtom);
    const efforts = useAtomValue(paletteEffortsAtom);
    const surface = useAtomValue(model.surfaceAtom);
    const bindings = useAtomValue(bindingsAtom);
    const mru = useAtomValue(paletteMruAtom);
    const themePreset = useAtomValue(themePresetAtom);
    const codeProject = useAtomValue(codeProjectAtom);
    const codeIndex = useAtomValue(codeIndexAtom);
    const codeHistory = useAtomValue(codeHistoryAtom);
    const [nav, setNavState] = useState<NavState>(() => initialNav(surface));
    const [sel, setSel] = useState(0);
    const [launchError, setLaunchError] = useState<string | undefined>(undefined);
    // Files off Code: the active project's index, loaded on first use of the scope
    const [loadedFiles, setLoadedFiles] = useState<{ path: string; index?: CodeIndex; error?: string } | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const loadedRef = useRef(false);

    const close = () => globalStore.set(model.paletteOpenAtom, false);
    const setNav = (next: NavState | ((s: NavState) => NavState)) => {
        setNavState(next);
        setSel(0);
        setLaunchError(undefined);
    };
    const q = nav.query.trim();

    // Lazy-load the sessions archive on first open (as SessionsSurface does).
    useEffect(() => {
        if (open && !loadedRef.current) {
            loadedRef.current = true;
            fireAndForget(loadSessionsArchive);
        }
        if (open) {
            loadFocuses();
            // records / initiatives: re-read per open (as loadFocuses does) so archiving one in
            // the Jarvis surface is reflected the next time the palette is asked to find it.
            loadPaletteEntities();
        }
    }, [open]);

    // Each open starts fresh on the surface's own scope, and focuses the input after paint.
    useEffect(() => {
        if (!open) {
            return;
        }
        setNav(initialNav(globalStore.get(model.surfaceAtom)));
        setLoadedFiles((cur) => (cur?.error != null ? null : cur)); // a failed listing gets another try
        const raf = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, [open]);

    // --- Files ------------------------------------------------------------------------------------
    // On Code, the project Code has open; elsewhere, the active project — not whatever Code last had.
    const fileTarget = useMemo(() => {
        if (surface === "code" && codeProject != null) {
            return codeProject;
        }
        if (channel?.projectpath) {
            return { name: channelProjectLabel(channel, projects), path: channel.projectpath };
        }
        return null;
    }, [surface, codeProject, channel, projects]);
    const codeOwnsTarget = codeProject != null && fileTarget != null && sameRepoPath(codeProject.path, fileTarget.path);
    const needFileLoad = open && nav.scope === "files" && fileTarget != null && !(codeOwnsTarget && codeIndex != null);
    useEffect(() => {
        if (!needFileLoad || loadedFiles?.path === fileTarget.path) {
            return;
        }
        const path = fileTarget.path;
        setLoadedFiles({ path });
        loadFileIndex(path).then(
            (index) => setLoadedFiles((cur) => (cur?.path === path ? { path, index } : cur)),
            (e) => setLoadedFiles((cur) => (cur?.path === path ? { path, error: String(e) } : cur))
        );
    }, [needFileLoad, fileTarget?.path]);
    const fileIndex: CodeIndex | undefined =
        codeOwnsTarget && codeIndex != null
            ? codeIndex
            : loadedFiles != null && loadedFiles.path === fileTarget?.path
              ? loadedFiles.index
              : undefined;
    const fileError = loadedFiles?.path === fileTarget?.path ? loadedFiles?.error : undefined;

    // --- Sources ----------------------------------------------------------------------------------
    const focusItems = useMemo<PaletteItem[]>(
        () =>
            buildFocusItems(spaces, activeSpace?.ref.id ?? null, {
                focus: (s) => {
                    // a task summary carries no project, so the project filter is left alone
                    enterFocusFor(model, { ref: { kind: "task", id: s.id }, label: s.objective, project: "" });
                    close();
                },
                exit: () => {
                    exitFocus();
                    close();
                },
            }).map((fi) => ({
                key: fi.key,
                kind: "focus-task" as const,
                search: fi.subtitle ? `${fi.title} ${fi.subtitle}` : fi.title,
                title: fi.title,
                meta: fi.subtitle,
                verb: "Focus",
                echo:
                    fi.key === "focus-exit"
                        ? "Shows everything again"
                        : `Narrows Cockpit and Sessions to “${fi.title}”`,
                run: fi.run,
            })),
        [spaces, activeSpace, model]
    );

    const themeItems = useMemo<PaletteItem[]>(
        () =>
            buildThemeItems(themePreset).map((t) => ({
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
            })),
        [themePreset]
    );

    // Registry-derived: the "Go to" bindings are the surfaces, everything else is a command.
    const { gotoItems, commandItems } = useMemo(() => {
        const drillMeta: Record<DrillId, string> = {
            theme: `${themeItems.length} themes ›`,
            focus: `${focusItems.length} tasks ›`,
        };
        const all = [
            ...buildCommandItems(bindings, postCloseContext(surface)),
            ...buildExtraItems({ openNewProject: () => globalStore.set(model.newProjectOpenAtom, true) }),
        ];
        const goto: PaletteItem[] = all
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
        const commands: CommandRow[] = all
            .filter((c) => c.group !== GOTO_GROUP)
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
        return { gotoItems: goto, commandItems: commands };
    }, [bindings, surface, model, themeItems.length, focusItems.length]);

    const agentItems = useMemo<PaletteItem[]>(
        () =>
            agents.map((a) => {
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
            }),
        [agents, model]
    );

    const runItems = useMemo<PaletteItem[]>(
        () =>
            runs.map((r) => {
                const view = runStatusView(r.status);
                const title = r.goal || "(untitled run)";
                return {
                    key: `run:${r.id}`,
                    kind: "run" as const,
                    search: title,
                    title,
                    status: { label: runStatusLabel(r, view.label), tone: runTone(view.tone) },
                    verb: "Open",
                    echo: "Opens the run in Jarvis",
                    run: () => {
                        fireAndForget(() => openTarget(model, { kind: "run", runId: r.id }));
                        close();
                    },
                };
            }),
        [runs, model]
    );

    const sessionItems = useMemo<PaletteItem[]>(() => {
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
    }, [sessions, model]);

    // Enter switches the active project and opens it.
    const channelItems = useMemo<PaletteItem[]>(
        () =>
            dedupeByProject(channels ?? []).map((c) => {
                const name = channelProjectLabel(c, projects);
                const current = c.oid === channel?.oid;
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
            }),
        [channels, channel, model, projects]
    );

    // Records and initiatives, archived ones included. briefpalette owns the index and the ranking (it
    // sinks archived rows below every live one), so this only maps its rows onto palette rows, in its
    // order: re-ranking here would undo the archived-last guarantee. Uncapped here — capGroups caps per
    // group, the only place a cap cannot starve one kind to feed another.
    const briefIndex = useMemo(
        () => buildBriefIndex({ records: records ?? [], efforts: efforts ?? [] }),
        [records, efforts]
    );
    const briefItems = useMemo<PaletteItem[]>(() => {
        const now = Date.now();
        const open = (row: BriefRow) => {
            // an effort row's id is already an address
            fireAndForget(() => openAddress(model, row.kind === "record" ? `task:${row.id}` : row.id));
        };
        return rankBriefRows(briefIndex, nav.query, briefIndex.length).rows.map((r) => ({
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
        }));
    }, [briefIndex, nav.query, model]);

    // --- Launch -----------------------------------------------------------------------------------
    // Projects scope with "<project> <goal>" targets that project; everywhere else, the active one.
    const projectLaunch = nav.scope === "projects" && nav.drill == null ? parseProjectLaunch(nav.query) : null;
    const pickedChannel = projectLaunch
        ? (resolveChannelToken(
              projectLaunch.token,
              (channels ?? []).map((c) => ({ c, name: channelProjectLabel(c, projects) }))
          )?.c ?? null)
        : null;
    const targetChannel = projectLaunch ? pickedChannel : channel;
    const launchGoal = projectLaunch ? projectLaunch.goal : nav.scope === "all" ? nav.query : "";
    const targetLabel = targetChannel ? channelProjectLabel(targetChannel, projects) : "";

    const launchItems = useMemo<PaletteItem[]>(() => {
        if (!targetChannel || launchGoal.trim() === "") {
            return [];
        }
        const ch = targetChannel;
        // a failure keeps the goal in the palette and says why; success surfaces the result, then closes
        const fireLaunch = (action: () => Promise<unknown>) => {
            setLaunchError(undefined);
            void runPaletteAction(action).then((result) => {
                if ("error" in result) {
                    setLaunchError(result.error.replace(/^Error:\s*/, ""));
                    return;
                }
                globalStore.set(model.surfaceAtom, "jarvis");
                close();
            });
        };
        const sendText = (text: string) =>
            sendChannelMessage({
                model,
                channelId: ch.oid,
                projectPath: ch.projectpath ?? "",
                projectName: channelProjectLabel(ch, projects) || "agent",
                roster: agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId })),
                text,
            });
        // Both starts go through createRun: that is the only path that captures a dossier, so a goal
        // started here lands in the record system like one started from the composer. A missing preferred
        // runtime blocks before any RPC: the goal stays in the palette, nothing dispatches.
        const guarded = (action: (route: RoutePin) => Promise<unknown>) => {
            fireLaunch(async () => action(await resolveChannelLaunchRoute(ch.oid)));
        };
        const deps: LaunchDeps = {
            quick: (goal) => guarded((route) => createRun(ch.oid, goal, route, { mode: "quick" })),
            orchestrate: (goal) => guarded((route) => createRun(ch.oid, goal, route, { mode: "orchestrator" })),
            // the user never types "ask @"; the transport string is synthesized for sendChannelMessage
            consult: (runtime, goal) => fireLaunch(() => sendText(`ask @${runtime} ${goal}`)),
        };
        return buildLaunchItems(launchGoal, channelProjectLabel(ch, projects), deps).map((li) => ({
            key: li.key,
            kind: "launch" as const,
            search: "",
            title: li.title,
            desc: li.desc,
            launchIcon: li.icon,
            verb: li.verb,
            echo: li.echo,
            run: li.run,
        }));
    }, [targetChannel, launchGoal, agents, model, projects]);

    // --- Groups -----------------------------------------------------------------------------------
    const widenItem: PaletteItem | null =
        q === ""
            ? null
            : {
                  key: "widen",
                  kind: "widen",
                  search: "",
                  title: `Search everything for “${q}”`,
                  verb: "Search",
                  echo: `Widens to All, keeping “${q}”`,
                  run: () => setNav((s) => pickScope(s, "all")),
              };
    const narrowed = (rows: PaletteItem[], order: GroupKind[], withWiden = true, query = nav.query) => {
        const def = scopeDef(nav.scope);
        return assembleScopeGroups({
            rows,
            order,
            label: def.label,
            noun: def.noun,
            query,
            widenItem: withWiden ? widenItem : null,
        });
    };

    let groups: PaletteGroup<PaletteItem>[];
    let cap = MAX_IN_SCOPE;
    let fileHighlight: string | undefined;
    if (nav.drill != null) {
        const rows = nav.drill === "theme" ? themeItems : focusItems;
        const hits = rankPaletteItems(rows, nav.query);
        groups = [
            {
                key: nav.drill,
                label: DRILL_LABELS[nav.drill],
                items: hits,
                ...(hits.length === 0 ? { emptyText: q === "" ? "Nothing to pick." : `Nothing matches “${q}”.` } : {}),
            },
        ];
    } else if (nav.scope === "all") {
        cap = MAX_IN_ALL;
        const pool = sortByMru(
            [...gotoItems, ...agentItems, ...runItems, ...sessionItems, ...channelItems, ...commandItems],
            mru
        );
        // mergeRanked interleaves by score without re-ranking either side, so the brief rows keep
        // briefpalette's order (archived last) while the merged head is still the best match overall
        const ranked = mergeRanked(nav.query, rankPaletteItems(pool, nav.query), briefItems);
        const asGoalItem: PaletteItem | null =
            launchItems.length > 0
                ? {
                      key: "as-goal",
                      kind: "as-goal",
                      search: "",
                      title: `Start “${q}” as a goal`,
                      meta: `#${targetLabel}`,
                      verb: "Choose",
                      echo: `Shows the ways to start “${q}”`,
                      run: () => setNav((s) => ({ ...s, asGoal: true })),
                  }
                : null;
        groups = assembleAllGroups({
            query: nav.query,
            ranked,
            recent: recentItems([...pool, ...briefItems], mru, MAX_RECENT),
            goto: gotoItems,
            launch: launchItems,
            asGoalItem,
            asGoal: nav.asGoal,
            projectLabel: `#${targetLabel}`,
        });
    } else if (nav.scope === "commands") {
        if (q === "") {
            groups = commandGroups(commandItems, surface);
        } else {
            const hits = rankPaletteItems(commandItems, nav.query);
            groups = hits.length > 0 ? [{ key: "command", label: "Commands", items: hits }] : narrowed([], ["command"]);
        }
    } else if (nav.scope === "projects" && projectLaunch != null) {
        groups =
            launchItems.length > 0
                ? [{ key: "launch", label: `Start in #${targetLabel}`, rich: true, items: launchItems }]
                : [
                      {
                          key: "empty",
                          label: "Projects",
                          items: [],
                          emptyText: `No project matches “${projectLaunch.token}”.`,
                      },
                  ];
    } else if (nav.scope === "files") {
        ({ groups, fileHighlight } = fileScopeGroups());
    } else if (nav.scope === "records") {
        groups = narrowed(briefItems, SCOPE_KINDS.records);
    } else {
        const pools: Partial<Record<ScopeId, PaletteItem[]>> = {
            goto: gotoItems,
            agents: agentItems,
            runs: runItems,
            sessions: sessionItems,
            projects: channelItems,
        };
        groups = narrowed(rankPaletteItems(pools[nav.scope] ?? [], nav.query), SCOPE_KINDS[nav.scope] ?? []);
    }

    function fileScopeGroups(): { groups: PaletteGroup<PaletteItem>[]; fileHighlight?: string } {
        const empty = (emptyText: string) => [{ key: "empty", label: "Files", items: [], emptyText }];
        if (fileTarget == null) {
            return { groups: empty("No project to search. Pick one on Code or in the cockpit.") };
        }
        const label = `#${fileTarget.name}`;
        if (fileError != null) {
            return { groups: empty(`Couldn’t list files in ${label}: ${fileError}`) };
        }
        if (fileIndex == null) {
            return { groups: empty(`Loading files in ${label}…`) };
        }
        if (!fileIndex.isRepo) {
            return { groups: empty(`${label} isn’t a git repository, so there is no file list.`) };
        }
        const recent = codeOwnsTarget ? recentPaths(codeHistory) : [];
        const fg = assembleFileGroups(nav.query, fileIndex.paths, recent, label, MAX_IN_SCOPE);
        const rows: PaletteGroup<PaletteItem>[] = fg.groups.map((g) => ({
            key: g.key,
            label: g.label,
            items: g.items.map((f) => ({
                key: `file:${f.path}`,
                kind: "file" as const,
                search: "",
                title: f.base,
                meta: [f.dir, fg.line != null ? `:${fg.line}` : ""].filter(Boolean).join("  ") || undefined,
                verb: "Open",
                echo: fileEcho(f, fg.line),
                run: () => {
                    close();
                    fireAndForget(() =>
                        openInCode(model, { projectPath: fileTarget.path, rel: f.path, line: fg.line })
                    );
                },
            })),
        }));
        // a bare ":152" on Code names no file, so it means "that line of the file already open"
        if (surface === "code" && fg.text === "" && fg.line != null) {
            const line = fg.line;
            rows.unshift({
                key: "line",
                label: "Open file",
                items: [
                    {
                        key: "line",
                        kind: "line",
                        search: "",
                        title: `Line ${line} of the open file`,
                        verb: "Go to",
                        echo: `Moves the open file to line ${line}`,
                        run: () => {
                            close();
                            globalStore.set(codePendingLineAtom, line);
                        },
                    },
                ],
            });
        }
        if (rows.length === 0) {
            // quote the path part: "readme:3" found no file named readme, not no file named "readme:3"
            return { groups: narrowed([], ["file"], false, fg.text) };
        }
        return { groups: rows, fileHighlight: fg.text };
    }

    const capped = capGroups(groups, cap);
    const flat = capped.flatMap((g) => g.items);
    const selClamped = flat.length === 0 ? 0 : Math.min(sel, flat.length - 1);
    const indexOf = new Map(flat.map((it, i) => [it.key, i]));
    const selected = flat[selClamped];

    // Arrow-keying past the visible rows used to move the selection out of view — the scroll container
    // was never told to follow it.
    // The first row goes to the very top, or a group header above it stays scrolled out of view (the
    // launch block's "Start in" line, after "as a goal" expands from the bottom of the list).
    useEffect(() => {
        if (selClamped === 0) {
            listRef.current?.scrollTo({ top: 0 });
            return;
        }
        listRef.current?.querySelector(`[data-idx="${selClamped}"]`)?.scrollIntoView({ block: "nearest" });
    }, [selClamped, capped.length, nav.asGoal, nav.scope, nav.drill]);

    // Only rows All can list are recorded: the launch, goal, widen and file rows are not things to
    // float back up under Recent (files have Code's own history).
    const fire = (it: PaletteItem | undefined) => {
        if (it == null) {
            return;
        }
        if (ALL_KIND_ORDER.includes(it.kind)) {
            globalStore.set(paletteMruAtom, (prev) => nextMru(prev, it.key));
        }
        it.run();
        // a row that keeps the palette open (as a goal, widen, a drill) hands the keyboard back to the
        // field; one that closed it must not pull focus into the exiting modal
        if (globalStore.get(model.paletteOpenAtom)) {
            inputRef.current?.focus();
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => (flat.length ? (Math.min(s, flat.length - 1) + 1) % flat.length : 0));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => (flat.length ? (Math.min(s, flat.length - 1) - 1 + flat.length) % flat.length : 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            fire(selected);
        } else if (e.key === "Tab") {
            e.preventDefault();
            setNav(cycleScope(nav, e.shiftKey ? -1 : 1));
        } else if (e.key === "Backspace") {
            const next = backspaceEmpty(nav);
            if (next != null) {
                e.preventDefault();
                setNav(next);
            }
        }
    };

    const placeholder =
        nav.drill != null
            ? DRILL_PLACEHOLDERS[nav.drill]
            : nav.scope === "files" && fileTarget != null
              ? `Open a file in #${fileTarget.name}, path:line jumps…`
              : scopeDef(nav.scope).placeholder;

    return (
        <ModalShell open={open} onClose={close} className="flex h-[min(580px,80vh)] w-[min(640px,93vw)] flex-col">
            {open ? (
                <>
                    <div className="flex shrink-0 items-center gap-[11px] px-4 py-[13px]">
                        <Search size={15} strokeWidth={2} className="shrink-0 text-muted" />
                        {nav.drill != null ? (
                            <button
                                type="button"
                                aria-label="Back to all commands"
                                onClick={() => {
                                    setNav((s) => ({ ...s, drill: null, query: "" }));
                                    inputRef.current?.focus();
                                }}
                                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-edge-mid bg-surface-raised px-2 py-0.5 text-[12px] text-secondary"
                            >
                                <span className="text-muted">Commands</span>
                                <span className="text-ink-faint">›</span>
                                <span>{DRILL_LABELS[nav.drill]}</span>
                            </button>
                        ) : null}
                        <input
                            ref={inputRef}
                            data-palette-input
                            aria-label="Search"
                            value={nav.query}
                            onChange={(e) => setNav(typeQuery(nav, e.target.value))}
                            onKeyDown={onKeyDown}
                            placeholder={placeholder}
                            autoComplete="off"
                            spellCheck={false}
                            className="min-w-0 flex-1 bg-transparent text-[14px] text-primary outline-none placeholder:text-muted"
                        />
                        <span className="shrink-0 rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-muted">
                            esc
                        </span>
                    </div>
                    <div
                        role="group"
                        aria-label="Scope"
                        className="flex shrink-0 items-center gap-0.5 border-b border-border px-2.5 pb-2"
                    >
                        {SCOPES.map((s) => {
                            const on = s.id === nav.scope;
                            return (
                                <button
                                    key={s.id}
                                    type="button"
                                    aria-pressed={on}
                                    data-palette-scope={s.id}
                                    tabIndex={-1}
                                    onClick={() => {
                                        setNav(pickScope(nav, s.id));
                                        inputRef.current?.focus();
                                    }}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-[5px] rounded-[7px] px-2 py-1 text-[12px] font-medium",
                                        on ? "bg-accentbg text-accent-soft" : "text-muted hover:text-secondary"
                                    )}
                                >
                                    <span>{s.label}</span>
                                    {s.sigil ? (
                                        <span
                                            className={cn(
                                                "font-mono text-[10.5px]",
                                                on ? "text-accent-soft" : "text-ink-faint"
                                            )}
                                        >
                                            {s.sigil}
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })}
                        <div className="flex-1" />
                        <span className="rounded-[5px] border border-edge-mid px-1.5 py-px font-mono text-[10px] text-muted">
                            Tab
                        </span>
                    </div>
                    {launchError ? (
                        <div
                            role="alert"
                            className="shrink-0 border-b border-error/30 bg-error/10 px-4 py-2 text-[12px] text-error-soft"
                        >
                            Launch failed: {launchError}
                        </div>
                    ) : null}
                    <div
                        ref={listRef}
                        role="listbox"
                        aria-label="Results"
                        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-1"
                    >
                        {capped.length === 0 ? (
                            <div className="px-4 py-8 text-center text-[13px] text-muted">
                                {q === ""
                                    ? "Nothing here yet."
                                    : `Nothing matches “${q}”, and no project to start it in.`}
                            </div>
                        ) : (
                            capped.map((g) => (
                                <PaletteGroupView
                                    key={g.key}
                                    group={g}
                                    indexOf={indexOf}
                                    selected={selClamped}
                                    query={fileHighlight ?? nav.query}
                                    onHover={setSel}
                                    onFire={fire}
                                />
                            ))
                        )}
                        {nav.scope === "files" && fileIndex?.truncated ? (
                            <div className="px-2.5 pt-2 font-mono text-[10.5px] text-muted">
                                Index truncated: searching the first 20,000 files only.
                            </div>
                        ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-[9px]">
                        <span className="shrink-0 font-mono text-[11px] text-accent-soft">⏎</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-secondary">
                            {selected?.echo ?? "Nothing to run"}
                        </span>
                        <span className="flex shrink-0 items-center gap-3 font-mono text-[10.5px] text-muted">
                            <span>↑↓ move</span>
                            <span>Tab scope</span>
                            <span>esc close</span>
                        </span>
                    </div>
                </>
            ) : null}
        </ModalShell>
    );
}
