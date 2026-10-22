// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The universal search — Ctrl+P on every surface. One overlay with visible scopes (All, Needs you, Go to,
// Agents, Runs, Sessions, Records, Notes, Projects, Files, Commands): Tab walks them, and a typed prefix ("r:")
// or one of the old sigils narrows to one from an empty All. In All, text that names something opens it
// and text that names nothing is a goal the launch rows start. Code's own file finder folded in as the
// Files scope, preselected there.
// This is the ONE palette: a new findable kind is a new entry source here, never a second overlay or a
// second shortcut. The rules live in the pure palette-*.ts modules; this file wires sources to them.

import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import { bindingsAtom } from "@/app/store/keybindings/store";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { activeChannelAtom, channelsAtom, primeChannels } from "@/app/view/agents/channelsstore";
import { projectListAtom, projectsAtom, recentProjectsAtom } from "@/app/view/agents/projectsstore";
import { loadSessionsArchive, sessionsArchiveAtom } from "@/app/view/agents/sessionsarchivestore";
import { themePresetAtom } from "@/app/view/agents/themestore";
import { buildBriefIndex } from "@/app/view/jarvis/briefpalette";
import { taskListAtom } from "@/app/view/jarvis/tasksstore";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { THING_KINDS } from "./actions";
import { verbRows } from "./actions/types";
import { errorText, runPaletteAction } from "./palette-action";
import {
    actionDrillGroups,
    bareLabel,
    runThingAction,
    verbItems,
    type ActionTarget,
    type StartAction,
} from "./palette-actionrows";
import { PaletteErrorBand, PaletteFooter, PaletteScopeTabs, PaletteSearchBar } from "./palette-chrome";
import { allRunsAtom, loadAllRuns, palettePickChannel } from "./palette-data";
import { loadPaletteEntities, paletteEffortsAtom } from "./palette-entities";
import { fileScopeGroups } from "./palette-files";
import { ALL_KIND_ORDER, capGroups } from "./palette-groups";
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
    notesInAll,
    runRows,
    sessionRows,
    startRows,
    themeRows,
    type PaletteDeps,
} from "./palette-items";
import { nextMru, paletteMruAtom } from "./palette-mru";
import { needsGroups, needsRows } from "./palette-needs";
import { PaletteNoteEditor } from "./palette-noteeditor";
import { noteKey, pressArm } from "./palette-notes";
import { loadPaletteNotes, paletteNotesAtom } from "./palette-notesstore";
import { PaletteNotesView } from "./palette-notesview";
import { PaletteGroupView, type PaletteItem } from "./palette-rows";
import {
    backspaceEmpty,
    caretAtEnd,
    cycleScope,
    initialNav,
    leaveActions,
    openActionInput,
    openActions,
    pickScope,
    placeholderFor,
    typeQuery,
    type NavState,
} from "./palette-scope";
import { scopeGroups } from "./palette-scopegroups";
import { useNoteEditor } from "./use-note-editor";
import { usePaletteFiles } from "./use-palette-files";

// how much of the preview's height PageUp/PageDown move it, so a line or two carries over
const PREVIEW_PAGE = 0.85;

export function CommandPalette({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(model.paletteOpenAtom);
    const agents = useAtomValue(model.agentsAtom);
    const sessions = useAtomValue(sessionsArchiveAtom);
    const channel = useAtomValue(activeChannelAtom);
    const channels = useAtomValue(channelsAtom);
    const runs = useAtomValue(allRunsAtom);
    const attention = useAtomValue(attentionAtom);
    const recentProjects = useAtomValue(recentProjectsAtom);
    const projectRows = useAtomValue(projectListAtom);
    const projects = useAtomValue(projectsAtom);
    const records = useAtomValue(taskListAtom);
    const efforts = useAtomValue(paletteEffortsAtom);
    const notes = useAtomValue(paletteNotesAtom);
    const surface = useAtomValue(model.surfaceAtom);
    const bindings = useAtomValue(bindingsAtom);
    const mru = useAtomValue(paletteMruAtom);
    const themePreset = useAtomValue(themePresetAtom);
    // every thing the palette can act on, per kind; computed only while open, as its sources move often
    const thingsAtom = useMemo(
        () =>
            atom((get) =>
                get(model.paletteOpenAtom) ? THING_KINDS.map((def) => ({ def, entries: def.entries(get, model) })) : []
            ),
        [model]
    );
    const things = useAtomValue(thingsAtom);
    const [nav, setNavState] = useState<NavState>(() => initialNav(surface));
    const [sel, setSel] = useState(0);
    const [paletteError, setPaletteError] = useState<string | undefined>(undefined);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const loadedRef = useRef(false);

    const close = () => globalStore.set(model.paletteOpenAtom, false);
    const setNav = (next: NavState | ((s: NavState) => NavState)) => {
        setNavState(next);
        setSel(0);
        setPaletteError(undefined);
    };
    const deps: PaletteDeps = { model, close, setNav, setSel, setPaletteError };
    const editor = useNoteEditor(open, inputRef, deps);
    const q = nav.query.trim();
    const atTop = nav.drill == null && nav.actions == null;

    // Lazy-load the sessions archive on first open (as SessionsSurface does).
    useEffect(() => {
        if (open && !loadedRef.current) {
            loadedRef.current = true;
            fireAndForget(loadSessionsArchive);
        }
        if (open) {
            // records / initiatives: re-read per open so archiving one in
            // the Jarvis surface is reflected the next time the palette is asked to find it.
            loadPaletteEntities();
            // notes too: an agent may have written one since the last open
            void runPaletteAction(loadPaletteNotes).then((result) => {
                if ("error" in result) {
                    setPaletteError(`Couldn’t load notes: ${errorText(result.error)}`);
                }
            });
            // only Jarvis loads the channel list, so a palette opened first thing elsewhere had no project to
            // start in and no runs; primeChannels, not loadChannels, which also selects a channel
            fireAndForget(primeChannels);
        }
    }, [open]);

    // every project's runs: nothing else keeps them, so the palette fans out per open once channels are in
    useEffect(() => {
        if (open && channels != null) {
            fireAndForget(() => loadAllRuns(channels));
        }
    }, [open, channels]);

    // the active project, else the one last used, else the only one
    const homeChannel = palettePickChannel(channel, projectRows, recentProjects[0] ?? null);

    // Each open starts fresh on the surface's own scope, and focuses the input after paint.
    useEffect(() => {
        if (!open) {
            return;
        }
        const seed = globalStore.get(model.paletteSeedAtom);
        globalStore.set(model.paletteSeedAtom, null);
        setNav({ ...initialNav(globalStore.get(model.surfaceAtom)), query: seed ?? "" });
        const raf = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, [open]);

    const files = usePaletteFiles(open, nav.scope === "files", surface, homeChannel, projects);

    // --- Sources ----------------------------------------------------------------------------------
    const themeItems = useMemo(() => themeRows(themePreset, deps), [themePreset]);
    const { gotoItems, commandItems } = useMemo(
        () => commandRows(bindings, surface, themeItems.length, deps),
        [bindings, surface, model, themeItems.length]
    );
    const startItems = useMemo(() => startRows(bindings, deps), [bindings, model]);
    const agentItems = useMemo(() => agentRows(agents, deps), [agents, model]);
    const runItems = useMemo(() => runRows(runs, channels, projects, deps), [runs, channels, projects, model]);
    const needs = useMemo(() => needsRows(attention, agents), [attention, agents]);
    const needsGrouped = useMemo(() => needsGroups(needs), [needs]);
    const needsByKey = useMemo(() => new Map(needs.map((r) => [`needs:${r.item.key}`, r])), [needs]);
    const needsItems = useMemo(() => needsPaletteRows(needsGrouped, deps), [needsGrouped, model]);
    const sessionItems = useMemo(() => sessionRows(sessions, deps), [sessions, model]);
    const channelItems = useMemo(() => channelRows(projectRows, channel, deps), [projectRows, channel, model]);
    const briefIndex = useMemo(
        () => buildBriefIndex({ records: records ?? [], efforts: efforts ?? [] }),
        [records, efforts]
    );
    const briefItems = useMemo(
        () => briefRows(briefIndex, nav.query, efforts, deps),
        [briefIndex, nav.query, model, efforts]
    );
    const noteByKey = useMemo(() => new Map((notes ?? []).map((n) => [noteKey(n.id), n])), [notes]);
    const noteItems = useMemo(() => noteRows(notes, editor.openDraft, deps), [notes]);
    const noteItemsInAll = notesInAll(noteItems, nav, deps);

    const launch = launchTarget(nav, channels, projects, homeChannel);
    const launchItems = useMemo(
        () => launchRows(launch.launchGoal, launch.unmatchedProject, launch.targetChannel, agents, projects, deps),
        [launch.targetChannel, launch.launchGoal, launch.unmatchedProject, agents, model, projects]
    );

    // --- Actions ----------------------------------------------------------------------------------
    const targetByKey = useMemo(() => {
        const m = new Map<string, ActionTarget>();
        for (const { def, entries } of things) {
            for (const entry of entries) {
                m.set(entry.key, { def, entry });
            }
        }
        return m;
    }, [things]);
    const allVerbs = useMemo(
        () => things.flatMap(({ def, entries }) => verbRows(def, entries).map((v) => ({ def, v }))),
        [things]
    );
    const thingMeta = useMemo(
        () => new Map([...agentItems, ...runItems, ...sessionItems, ...channelItems].map((it) => [it.key, it.meta])),
        [agentItems, runItems, sessionItems, channelItems]
    );
    const drillThing = (t: ActionTarget) => ({ key: t.entry.key, title: t.entry.title, noun: t.def.noun });
    // an action that takes a value opens its input level, inside the thing's action list, first
    const startAction: StartAction = (t, action) => {
        if (action.input == null) {
            runThingAction(t, action, deps);
            return;
        }
        const inList = nav.actions?.thing.key === t.entry.key ? nav : openActions(nav, drillThing(t), selClamped);
        setNav(openActionInput(inList, { actionId: action.id, label: bareLabel(action) }));
    };
    const verbs = verbItems(allVerbs, nav.query, thingMeta, startAction);

    // --- Groups -----------------------------------------------------------------------------------
    const { groups, cap, fileHighlight } = scopeGroups(
        {
            nav,
            surface,
            mru,
            rows: {
                theme: themeItems,
                goto: gotoItems,
                commands: commandItems,
                start: startItems,
                agents: agentItems,
                runs: runItems,
                sessions: sessionItems,
                channels: channelItems,
                brief: briefItems,
                notes: noteItems,
                notesInAll: noteItemsInAll,
                launch: launchItems,
                verbs: verbs.items,
                needs: needsItems,
            },
            needsGrouped,
            verbByKey: verbs.byKey,
            launch,
            actionGroups: () => actionDrillGroups(nav, targetByKey, startAction, deps),
            fileGroups: () => fileScopeGroups({ query: nav.query, surface, ...files }, deps),
        },
        deps
    );

    // a thing's row says how many of its actions apply now; → opens them
    const withActions = (it: PaletteItem): PaletteItem => {
        const t = nav.actions == null ? targetByKey.get(it.key) : undefined;
        const n = t == null ? 0 : t.def.actions.filter((a) => a.applies(t.entry.thing)).length;
        return n > 0 ? { ...it, actions: n } : it;
    };
    // the Notes scope: the list beside a preview, instead of the one column
    const notesSplit = nav.scope === "notes" && atTop;
    const newNoteItem = newNoteRow(nav.query, editor.openDraft);
    // "New note" joins after the cap, so a long list cannot push it out
    const capped = capGroups(groups, cap).map((g) => ({
        ...g,
        items: [...g.items.map(withActions), ...(notesSplit ? [newNoteItem] : [])],
    }));
    const flat = capped.flatMap((g) => g.items);
    const selClamped = flat.length === 0 ? 0 : Math.min(sel, flat.length - 1);
    const indexOf = new Map(flat.map((it, i) => [it.key, i]));
    const selected = flat[selClamped];
    const selectedNote = notesSplit ? noteByKey.get(selected?.key) : undefined;
    const armedDelete = editor.armed?.key === "del" && editor.armed.target === selected?.key;

    // an armed delete is for the row it was pressed on, with the text as it then was
    useEffect(() => editor.setArmed(null), [selected?.key, nav.query]);

    // The selected Needs you ask shows its options under it. They join the rows only after the selection is
    // resolved and never the selection order, so showing them cannot move what ↑↓ lands on.
    const answering =
        nav.scope === "needs" && nav.actions == null && selected?.kind === "needs"
            ? needsByKey.get(selected.key)
            : undefined;
    const answers = answerRows(answering, deps);
    const shown =
        answers.length === 0
            ? capped
            : capped.map((g) => {
                  const at = g.items.findIndex((it) => it.key === selected.key);
                  return at < 0
                      ? g
                      : { ...g, items: [...g.items.slice(0, at + 1), ...answers, ...g.items.slice(at + 1)] };
              });

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
    }, [selClamped, capped.length, nav.asGoal, nav.scope, nav.drill, nav.actions]);

    // Only rows All can list are recorded: the launch, goal, widen and file rows are not things to
    // float back up under Recent (files have Code's own history), and neither are actions, so a Cancel
    // run never waits on the empty screen, nor notes, which Recent never lists.
    const fire = (it: PaletteItem | undefined) => {
        if (it == null) {
            return;
        }
        if (ALL_KIND_ORDER.includes(it.kind) && it.kind !== "action" && it.kind !== "note") {
            globalStore.set(paletteMruAtom, (prev) => nextMru(prev, it.key));
        }
        it.run();
        // a row that keeps the palette open (as a goal, widen, a drill) hands the keyboard back to the
        // field; one that closed it must not pull focus into the exiting modal
        if (globalStore.get(model.paletteOpenAtom)) {
            inputRef.current?.focus();
        }
    };

    const openRowActions = (idx: number) => {
        const t = targetByKey.get(flat[idx]?.key);
        if (t != null) {
            setNav(openActions(nav, drillThing(t), idx));
        }
    };
    // back one level: an action's input to its thing's list, the list to the results it came from
    const leaveLevel = () => {
        if (nav.actions?.input != null) {
            setNav({ ...nav, query: "", actions: { ...nav.actions, input: null } });
            return;
        }
        const back = leaveActions(nav);
        if (back != null) {
            setNav(back.nav);
            setSel(back.sel);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        // a digit past the ask's options is query text, as in any other scope
        const digit = /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey ? Number(e.key) : 0;
        const bare = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
        // mid-query, Del edits the text as it always has
        const del =
            e.key === "Delete" &&
            bare &&
            selectedNote != null &&
            caretAtEnd(nav.query, inputRef.current?.selectionStart ?? null);
        if (!del) {
            editor.setArmed(null);
        }
        if (del) {
            e.preventDefault();
            // a held key must not confirm its own delete
            if (e.repeat) {
                return;
            }
            const press = pressArm(editor.armed, "del", selected.key);
            editor.setArmed(press.armed);
            if (press.fire) {
                editor.deleteNote(selectedNote, selClamped, flat.length - 1); // less the "New note" row
            }
        } else if ((e.key === "PageDown" || e.key === "PageUp") && selectedNote != null) {
            e.preventDefault();
            const pane = previewRef.current;
            pane?.scrollBy({ top: (e.key === "PageDown" ? 1 : -1) * pane.clientHeight * PREVIEW_PAGE });
        } else if (digit > 0 && digit <= answers.length) {
            e.preventDefault();
            fire(answers[digit - 1]);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => (flat.length ? (Math.min(s, flat.length - 1) + 1) % flat.length : 0));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => (flat.length ? (Math.min(s, flat.length - 1) - 1 + flat.length) % flat.length : 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.ctrlKey && selected?.alt != null) {
                const alt = selected.alt;
                fire({ ...selected, run: alt.run });
            } else {
                fire(selected);
            }
        } else if (e.key === "Tab") {
            e.preventDefault();
            setNav(cycleScope(nav, e.shiftKey ? -1 : 1));
        } else if (e.key === "ArrowRight") {
            // mid-query, → moves the caret as it always has
            const caret = inputRef.current?.selectionStart ?? null;
            if (bare && nav.actions == null && selected?.actions && caretAtEnd(nav.query, caret)) {
                e.preventDefault();
                openRowActions(selClamped);
            }
        } else if (e.key === "ArrowLeft") {
            if (bare && nav.actions != null && nav.query === "") {
                e.preventDefault();
                leaveLevel();
            }
        } else if (e.key === "Backspace") {
            if (nav.actions != null && nav.query === "") {
                e.preventDefault();
                leaveLevel();
                return;
            }
            const next = backspaceEmpty(nav);
            if (next != null) {
                e.preventDefault();
                setNav(next);
            }
        }
    };

    const fileTarget = files.target;
    const placeholder =
        atTop && nav.scope === "files" && fileTarget != null
            ? `Open a file in #${fileTarget.name}, path:line jumps${surface === "code" ? ", @ lists symbols" : ""}…`
            : placeholderFor(nav);
    const editing = editor.draft != null;

    return (
        <ModalShell
            open={open}
            onClose={editing ? editor.leaveDraft : close}
            className="flex h-[min(600px,80vh)] w-[min(820px,93vw)] flex-col"
        >
            {open && editor.draft != null ? (
                <PaletteNoteEditor
                    draft={editor.draft}
                    error={paletteError}
                    discardArmed={editor.armed?.key === "esc"}
                    titleRef={inputRef}
                    bodyRef={editor.bodyRef}
                    onChange={editor.editDraft}
                    onKeyDown={editor.onEditorKeyDown}
                    onLeave={editor.leaveDraft}
                />
            ) : open ? (
                <>
                    <PaletteSearchBar
                        nav={nav}
                        placeholder={placeholder}
                        inputRef={inputRef}
                        onQuery={(value) => setNav(typeQuery(nav, value))}
                        onKeyDown={onKeyDown}
                        onLeaveDrill={() => setNav((s) => ({ ...s, drill: null, query: "" }))}
                        onLeaveLevel={leaveLevel}
                    />
                    <PaletteScopeTabs
                        scope={nav.scope}
                        needsCount={needs.length}
                        onPick={(scope) => {
                            setNav(pickScope(nav, scope));
                            inputRef.current?.focus();
                        }}
                    />
                    <PaletteErrorBand error={paletteError} />
                    {notesSplit ? (
                        <PaletteNotesView
                            rows={flat}
                            selected={selClamped}
                            note={selectedNote}
                            query={nav.query}
                            overflow={capped[0].overflow}
                            listRef={listRef}
                            previewRef={previewRef}
                            onHover={setSel}
                            onFire={fire}
                        />
                    ) : (
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
                                shown.map((g) => (
                                    <PaletteGroupView
                                        key={g.key}
                                        group={g}
                                        indexOf={indexOf}
                                        selected={selClamped}
                                        query={fileHighlight ?? nav.query}
                                        onHover={setSel}
                                        onFire={fire}
                                        onActions={(idx) => {
                                            openRowActions(idx);
                                            inputRef.current?.focus();
                                        }}
                                    />
                                ))
                            )}
                            {nav.scope === "files" && files.index?.truncated ? (
                                <div className="px-2.5 pt-2 font-mono text-[10.5px] text-muted">
                                    Index truncated: searching the first 20,000 files only.
                                </div>
                            ) : null}
                        </div>
                    )}
                    <PaletteFooter
                        echo={selected?.echo ?? "Nothing to run"}
                        extra={footerLines(selected, answering, selectedNote, armedDelete)}
                        inActions={nav.actions != null}
                    />
                </>
            ) : null}
        </ModalShell>
    );
}
