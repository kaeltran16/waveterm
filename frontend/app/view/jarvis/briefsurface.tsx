// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief: the queue-first Jarvis surface that replaces the Subjects · Stage · rail composition.
// Four bounded regions — waiting on you, initiatives, sessions, behind you — over the briefing
// snapshot, under a header whose fleet line comes off the live agent roster.
//
// Two rules shape every region. Absence is a written sentence, never a heading over an empty frame:
// a region renders rows or it says what is not there, and the `empty` flag on Region makes that
// structural rather than a habit. And every count printed is the number of rows rendered beneath it,
// with whatever the projection's caps hid stated separately as "+N more" — so no line here can claim
// more work than the surface is showing.
//
// The record peek is here (BriefPeek, opened by a record oref) and the palette extends the app's own. Every
// row is one line that opens its sheet in a click (briefrows.ts), because the sheet is where the actions
// live; a region's overflow and its folded stale runs open in place. The composer and the thread it grows
// into are here.
//
// One presentation rule runs through the whole file and decides every border below: a bordered chip is
// the control recipe, a borderless one is a label. Dressing something inert as a control and camouflaging
// a real control among labels are the same lie, so neither happens here.

import {
    cardVariants,
    computeEntrances,
    easeFluidCss,
    initialEntranceState,
    MOTION,
    paneReveal,
} from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { buildJarvisBindings } from "@/app/store/keybindings/bindings";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useKeybindings } from "@/app/store/keybindings/store";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { ambientProviderAtom, ensureAmbient } from "@/app/view/agents/ambientstore";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { steerWorker } from "@/app/view/agents/channelactions";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { activeChannelAtom, channelsAtom, loadChannels } from "@/app/view/agents/channelsstore";
import { channelProjectLabel } from "@/app/view/agents/projectlabel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { RollingCount } from "@/app/view/agents/rollingcount";
import {
    getJarvisProfile,
    pendingRunDraftAtom,
    refreshResolvedProfile,
    setChannelProfile,
} from "@/app/view/agents/runactions";
import { DagModal } from "@/app/view/orchestrate/dagmodal";
import { setDagModalAgentsContext } from "@/app/view/orchestrate/dagmodalstate";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "motion/react";
import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
} from "react";
import { parseAddress, type AddressHint } from "./address";
import { AutonomyLadder } from "./autonomyladderview";
import { resolveComposerLabels, type BriefComposeState } from "./briefcompose";
import { resolveBriefComposerTarget } from "./briefcomposertarget";
import { drewOn, type DrewRow } from "./briefdrew";
import { turnProse, turnVerdict } from "./briefturn";
import { briefFleet } from "./brieffleet";
import { BRIEFING_FIXTURES } from "./briefingfixtures";
import {
    buildAttentionQueue,
    capRegion,
    DELTA_CAP,
    EFFORT_CAP,
    groupDelta,
    projectBriefing,
    SEVEN_DAYS_MS,
    SHIPPED_CAP,
    summarizeAttentionQueue,
    type QueueSummary,
} from "./briefingmodel";
import {
    ackBriefingVisit,
    askAcrossWork,
    briefDraftAtom,
    briefingAnswerAtom,
    briefingAskStateAtom,
    briefingFixtureAtom,
    briefingStateAtom,
    briefRestoreConsumedAtom,
    briefScopeAtom,
    briefThreadAtom,
    clearBriefThread,
    hydrateBriefThread,
    loadBriefing,
    refreshBriefing,
    type BriefExchange,
    type BriefingAnswer,
} from "./briefingstore";
import { resolveBriefCursor } from "./briefnav";
import { BriefPeek } from "./briefpeekview";
import { BriefProfileModal } from "./briefprofileview";
import { briefRestorePlan } from "./briefrestore";
import {
    behindGroups,
    filterLines,
    initiativeLine,
    queueLine,
    sessionLine,
    sessionWindow,
    SHIPPED_LABEL,
    type BriefLine,
    type LineTarget,
    type LineTone,
} from "./briefrows";
import { BriefSheet } from "./briefsheet";
import { sheetFace } from "./briefsheetmodel";
import { openJarvisWithSource } from "./contextualentry";
import { effortFeed, feedNoteCounts } from "./effortfeed";
import {
    addChunkOp,
    appendChunkNote,
    effortChunkRows,
    effortDetailAtom,
    loadEffortDetail,
    setChunkStatus,
    setEffortStatus,
} from "./effortstore";
import { freshKeys } from "./freshrows";
import { peekFocus, type PeekFocus } from "./graphfocus";
import { GraphPeek } from "./graphpeek";
import { expandableORef, trackerNavIds, trackerRows, type DetailRow } from "./inlinetracker";
import { InitiativeDetail, NoteSidebar } from "./inlinetrackerview";
import {
    isAnswerTurn,
    type Freshness,
    type JarvisConversation,
    type JarvisTurn,
    type SourceRef,
    type Terminal,
} from "./jarviscontract";
import {
    briefComposerHeightAtom,
    briefGraphRecordAtom,
    briefPeekRecordAtom,
    briefSheetOpenAtom,
    conversationsByIdAtom,
    graphPeekOpenAtom,
    loadJarvisConversations,
    noteChunkAtom,
    persistedSummariesAtom,
    readingNoteAtom,
    selectConversation,
} from "./jarvisstore";
import { activeSubjectAtom, persistedSubjectAtom, stageRunAtom } from "./jarvissubjectstore";
import { mentionedDossierIds } from "./mentions";
import { NewInitiativeControl } from "./newinitiativecontrol";
import { NewRunControl } from "./newruncontrol";
import { openAddress, openChannelSheet, openTarget } from "./openref";
import { reducePrinciplePatch } from "./profilemodel";
import { ProgressBar } from "./progressbar";
import { ageLabel, freshnessLabel } from "./recallderive";
import { loadTaskList, taskListAtom } from "./tasksstore";

const REGIONS = {
    waiting: {
        label: "Waiting on you",
        absent: "Nothing is waiting on you. The next gate or ask arrives here.",
        ok: true,
    },
    initiatives: { label: "Initiatives", absent: "No initiative is active.", ok: false },
    sessions: { label: "Sessions", absent: "Nothing is running on its own.", ok: false },
    behind: { label: "Behind you", absent: "Nothing has landed since you last looked.", ok: false },
} as const;
type RegionId = keyof typeof REGIONS;

const REGION_LABEL = "flex-none font-mono text-[9.5px] font-bold uppercase tracking-[.13em]";
const SUB_LABEL = "px-2.5 pb-0.5 pt-1.5 font-mono text-[9px] font-bold uppercase tracking-[.12em] text-ink-faint";

// The j/k cursor. A ring rather than a fill: the cursor says "the keys are here", not "this is
// selected" — nothing on the Brief is selectable yet, and the rows carry their own tone (a waiting row
// is already asking-coloured) which a background swap would overwrite. Inset, because the Waiting rows sit
// in the reveal's overflow-hidden wrapper, which cuts an outer ring down to its four rounded corners.
const CURSOR_RING = "ring-1 ring-inset ring-accent/70";

// Every row takes the same two, so the four renderers stay uniform and the scroller can find the cursor.
function cursorAttrs(focused: boolean) {
    return { "data-jarvis-brief-cursor": focused ? "true" : undefined };
}

// A heading is also how one region is read alone: pressing it hides the other regions, pressing it again
// brings them back. The count is a plain label inside it, because a bordered pill inside a button would
// read as a second control.
function RegionHead({
    label,
    meta,
    count,
    alert,
    only,
    onOnly,
}: {
    label: string;
    meta: string;
    count?: number;
    alert?: boolean;
    only: boolean;
    onOnly: () => void;
}) {
    return (
        <button
            type="button"
            aria-pressed={only}
            title={only ? "Show every region" : "Show only this region"}
            onClick={onOnly}
            className="flex w-full cursor-pointer items-center gap-[9px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {alert ? (
                <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-asking motion-reduce:animate-none" />
            ) : null}
            <span className={cn(REGION_LABEL, alert ? "text-asking" : "text-feed-label")}>{label}</span>
            {count != null ? (
                <span className="flex-none font-mono text-[10.5px] font-medium tabular-nums text-muted">{count}</span>
            ) : null}
            <span className="h-px min-w-3 flex-1 bg-edge-faint" />
            <span className="flex-none font-mono text-[10px] text-ink-faint">
                {only ? "showing only this · press to show all" : meta}
            </span>
        </button>
    );
}

function Region({
    id,
    meta,
    count,
    alert,
    empty,
    gap,
    only,
    onOnly,
    children,
}: {
    id: RegionId;
    meta: string;
    count?: number;
    alert?: boolean;
    empty: boolean;
    gap: string;
    only: boolean;
    onOnly: () => void;
    children: ReactNode;
}) {
    const region = REGIONS[id];
    return (
        <section data-jarvis-brief-region={id} className={cn("flex flex-col", gap)}>
            <RegionHead label={region.label} meta={meta} count={count} alert={alert} only={only} onOnly={onOnly} />
            {empty ? (
                <div className="flex items-center gap-[11px] rounded-[10px] border border-dashed border-edge-strong bg-surface px-4 py-3">
                    {region.ok ? (
                        <span aria-hidden className="flex-none font-mono text-[12px] font-bold text-success">
                            ✓
                        </span>
                    ) : null}
                    <span className="text-[13px] text-secondary">{region.absent}</span>
                </div>
            ) : (
                children
            )}
        </section>
    );
}

// What the region's window hid, and the way past it. There is no all-initiatives or all-events surface
// to send this anywhere — the three-pane composition's rail was the old destination and B5 deleted it —
// so the overflow opens in place. Bordered because it is a control: invariant 4 forbids the borderless
// link-coloured span this used to be, which named a number and did nothing.
function MoreControl({ n, expanded, onToggle }: { n: number; expanded: boolean; onToggle: () => void }) {
    if (n <= 0 && !expanded) {
        return null;
    }
    return (
        <button
            type="button"
            data-jarvis-brief-more={expanded ? "less" : "more"}
            onClick={onToggle}
            className="mt-0.5 cursor-pointer self-start rounded-[6px] border border-border px-2.5 py-1 font-mono text-[10.5px] font-medium text-accent-soft hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {expanded ? "Show less" : `+${n} more`}
        </button>
    );
}

function QueueSummaryView({
    summary,
    count,
    expanded,
    error,
    onToggle,
}: {
    summary: QueueSummary;
    count: number;
    expanded: boolean;
    error: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="grid w-full grid-cols-[3px_minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] border border-border bg-surface py-[9px] pl-3 pr-[11px]">
            <span className={cn("self-stretch rounded-[2px]", error ? "bg-error" : "bg-asking")} />
            <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-ink-hi">{summary.title}</span>
                <span className="mt-0.5 block truncate font-mono text-[9.5px] text-muted">{summary.detail}</span>
            </span>
            <button
                type="button"
                aria-expanded={expanded}
                aria-controls="jarvis-attention-details"
                onClick={onToggle}
                data-jarvis-brief-attention-summary
                className="flex-none cursor-pointer rounded-[7px] border border-edge-mid bg-surface-raised px-2.5 py-1 font-mono text-[10px] font-semibold text-muted hover:border-edge-strong hover:bg-surface-hover hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                {expanded ? "Hide" : count === 1 ? "Review" : `Review ${count}`}
            </button>
        </div>
    );
}

const TONE_FG: Record<LineTone, string> = {
    ok: "text-success",
    active: "text-accent-soft",
    asking: "text-asking",
    error: "text-error",
    muted: "text-muted",
};

// the key the fresh and entrance sets are built with: a line's id minus its region prefix
const keyOf = (line: BriefLine) => line.id.slice(line.id.indexOf(":") + 1);

// a filter that matched nothing in a region leaves a sentence, not a heading over an empty frame
function NoMatch() {
    return (
        <span className="px-[11px] py-1 font-mono text-[10.5px] text-ink-faint">Nothing here matches the filter.</span>
    );
}

// Every region's row: one line that opens its sheet (briefrows.ts builds them). A line with no destination
// stays a row rather than becoming a control that navigates nowhere. The padding and border are the same
// under the cursor as off it, so moving the cursor never shifts the rows below.
function LineRow({
    line,
    hook,
    focused,
    fresh,
    expanded,
    onOpen,
}: {
    line: BriefLine;
    hook: string;
    focused: boolean;
    fresh: boolean;
    // an initiative row opens in place rather than into a sheet; it keeps its top corners and gives up
    // its bottom ones to the plan block that follows, so the two read as one card
    expanded?: boolean;
    onOpen?: () => void;
}) {
    const reduce = useReducedMotion();
    const face = (
        <>
            {line.progress != null ? (
                <span className="flex w-[92px] flex-none items-center gap-[7px]">
                    <ProgressBar pct={line.progress.pct} className="min-w-0 flex-1" />
                    <span className="flex-none font-mono text-[9.5px] text-muted">
                        {line.progress.done}/{line.progress.total}
                    </span>
                </span>
            ) : (
                <span
                    className={cn(
                        "w-[92px] flex-none truncate font-mono text-[10px] font-semibold tracking-[.04em]",
                        TONE_FG[line.kindTone]
                    )}
                >
                    {line.kind}
                </span>
            )}
            <span
                title={line.note !== "" ? `${line.title} — ${line.note}` : line.title}
                className="min-w-0 flex-1 truncate text-[13px] text-ink-hi"
            >
                {line.title}
                {line.note !== "" ? <span className="text-muted"> — {line.note}</span> : null}
            </span>
            <span className="w-[210px] flex-none truncate text-right font-mono text-[10.5px] text-muted">
                {line.meta}
            </span>
            <span
                className={cn(
                    "w-[76px] flex-none truncate text-right font-mono text-[10.5px]",
                    focused && "font-semibold",
                    TONE_FG[line.stateTone]
                )}
            >
                {line.state}
            </span>
        </>
    );
    const base = cn(
        "flex w-full min-w-0 items-center gap-[13px] rounded-[9px] border-b px-[11px] py-1.5 text-left",
        // the fill stops at the padding box, where the inset ring is drawn, not under the transparent divider
        focused ? cn("border-transparent bg-surface-raised bg-clip-padding", CURSOR_RING) : "border-edge-faint",
        expanded && "rounded-b-none border-transparent bg-surface-selected",
        fresh && "fresh-mark"
    );
    // A disclosure row's bottom corners have to reopen as slowly as the pane below them leaves, or the
    // row snaps back to a full card while the plan is still on screen. Radius only: easing the fill too
    // would put the same lag on the j/k cursor, and the cursor has to feel instant.
    const cornerTween: CSSProperties | undefined =
        expanded === undefined || reduce
            ? undefined
            : { transition: `border-radius ${MOTION.durExit}s ${easeFluidCss}` };
    if (onOpen == null) {
        return (
            <div data-jarvis-brief-row={hook} {...cursorAttrs(focused)} className={base} style={cornerTween}>
                {face}
            </div>
        );
    }
    return (
        <button
            type="button"
            aria-label={expanded === true ? `Collapse ${line.title}` : `Open ${line.title}`}
            aria-expanded={expanded}
            onClick={onOpen}
            data-jarvis-brief-row={hook}
            style={cornerTween}
            {...cursorAttrs(focused)}
            className={cn(
                base,
                "cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            )}
        >
            {face}
        </button>
    );
}

// --- the composer, and the thread it grows into ----------------------------------------------------
// One composer that never moves: asking grows a thread above it and Escape collapses it back to a line.
// Every word on it — scope, placeholder, action, the optional second thing Enter could do — comes from
// resolveComposerLabels, so nothing here can describe the composer differently from briefcompose's tests.
// Who a keystroke reaches never changes on this surface: it is composertarget's `jarvis-briefing` case,
// one audience (Jarvis) over all work, which is why the labels never have to name a worker.
//
// The ask is briefingstore's existing all-work ask, unchanged. It is stateless and is never a persisted
// JarvisConversation, so the turns accumulate here and Escape discards them — there is nothing on the
// wire to resume a collapsed one from, and the thread list deliberately does not carry one-shot lookups.

// module scope, not useState: a j/k cursor that reset on every glance at another surface would be worse
// than none. Composer state lives in briefingstore so contextual entry can seed it before this mounts.
// Cast per this repo's convention: under the pinned jotai, atom<T | undefined>(undefined) infers a
// read-only Atom, and the setter is only callable once it is a PrimitiveAtom.
const briefCursorAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

// The inline tracker's state, module scope for the cursor's reason: the Brief unmounts on every surface
// switch, and an initiative that silently re-collapsed while you were away would be worse than none.
// Keyed by BRIEF LINE id rather than oref, because the same effort can also sit in Behind you and only
// its Initiatives row expands.
const openInitiativeAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
const stageOverridesAtom = atom<Record<string, boolean>>({});

// Which regions the user has opened past their window. Module scope for the same reason as the cursor:
// the Brief unmounts on every surface switch, and a region that silently re-collapsed while you were
// reading a record would be worse than one that never opened.
const briefExpandedAtom = atom<Partial<Record<RegionId, boolean>>>({});

// Whether Sessions shows its runs older than seven days. Module scope for the same reason as the two above.
const briefStaleOpenAtom = atom(false);

const COMPOSER_CHIP = "flex-none font-mono text-[9.5px] font-semibold";
const TURN_WHO = "flex-none font-mono text-[9px] font-bold uppercase tracking-[.11em]";
const BAND_LABEL = "flex-none font-mono text-[9px] font-bold uppercase tracking-[.12em] text-ink-faint";

function userTurn(text: string, attachments: SourceRef[]): JarvisTurn {
    return { role: "user", text, attachments };
}

function answerTurn(a: BriefingAnswer): JarvisTurn {
    return {
        role: "jarvis",
        workingSteps: [],
        segments: [{ text: a.answer }],
        // the ask now returns the same grounding card the conversation path builds, carrying a real
        // project, age and freshness reading. This was a local re-derivation over a wire shape that
        // carried none of the three, which is what forced every citation here to read "unverified".
        grounding: a.grounding,
        terminal: a.terminal as Terminal,
    };
}

// invariant 7: a thread resting on something stale or gone has to say so, as a word. groundingrail.tsx is
// the only other renderer of freshness in the repo and that rail is being retired, so this band is where
// it has to stay legible — hence the label first, and the colour only alongside it.
function freshnessFg(f: Freshness): string {
    switch (f) {
        case "fresh":
            return "text-success";
        case "stale":
            return "text-warning";
        case "unavailable":
            return "text-error";
        // an absence of verification is not a health reading, so it stays off the success/warning/error scale
        case "unverified":
            return "text-muted";
    }
}

// A citation opens its source, so it is bordered; one the router would refuse is a label, because there is
// nothing to open. The gate reads the same hint the click passes, so the two cannot disagree. `unavailable`
// and unopenable stay separate reads: a converse thread can report a source stale or gone while its address
// still opens, and that row must still be clickable.
function SourceChip({
    hook,
    target,
    hint,
    model,
    children,
}: {
    hook: string;
    target: string;
    hint?: AddressHint;
    model: AgentsViewModel;
    children: ReactNode;
}) {
    const shell =
        "flex max-w-[300px] min-w-0 items-center gap-[7px] rounded-[6px] px-[9px] py-1 font-mono text-[10px] text-muted";
    if (parseAddress(target, hint).kind === "unsupported") {
        return (
            <span data-jarvis-brief-row={hook} className={shell}>
                {children}
            </span>
        );
    }
    return (
        <button
            type="button"
            data-jarvis-brief-row={hook}
            onClick={() => fireAndForget(() => openAddress(model, target, hint))}
            className={cn(
                shell,
                "cursor-pointer border border-border bg-surface hover:border-accent/40 hover:text-ink-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            )}
        >
            {children}
        </button>
    );
}

function TurnView({ exchange, model }: { exchange: BriefExchange; model: AgentsViewModel }) {
    const turn = exchange.turn;
    const jarvis = isAnswerTurn(turn);
    const refs = isAnswerTurn(turn) ? turn.grounding : [];
    const verdict = isAnswerTurn(turn) ? turnVerdict(turn.terminal) : null;
    return (
        <div data-jarvis-brief-row="turn" className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center gap-[9px]">
                <span className={cn(TURN_WHO, jarvis ? "text-accent-soft" : "text-muted")}>
                    {jarvis ? "Jarvis" : "You"}
                </span>
                <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                    {formatAge(Date.now() - exchange.ts)}
                </span>
                {verdict != null ? (
                    <span
                        className={cn(
                            "flex-none font-mono text-[9.5px] font-semibold",
                            verdict.tone === "warning" ? "text-warning" : "text-muted"
                        )}
                    >
                        {verdict.label}
                    </span>
                ) : null}
            </div>
            <span className="whitespace-pre-wrap text-[13px] leading-[1.6] text-ink-mid">{turnProse(turn)}</span>
            {refs.length > 0 ? (
                // the prose carries the model's own [n] markers, so the per-turn chips are that legend;
                // the Drew band below is the thread's footing, deduped and with the freshness on it.
                <div className="flex min-w-0 flex-wrap gap-[7px]">
                    {refs.map((c) => (
                        <SourceChip
                            key={c.n}
                            hook="cite"
                            target={c.navTarget}
                            hint={{ sourceType: c.sourceType, anchor: c.anchor }}
                            model={model}
                        >
                            <span className="flex-none font-bold text-accent-soft">[{c.n}]</span>
                            <span className="min-w-0 truncate">{c.title}</span>
                        </SourceChip>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function DrewChip({ row, model }: { row: DrewRow; model: AgentsViewModel }) {
    return (
        <SourceChip
            hook="drew"
            target={row.navTarget}
            hint={{ sourceType: row.sourceType, anchor: row.anchor }}
            model={model}
        >
            <span className="flex-none text-ink-faint">{row.sourceType}</span>
            <span className="min-w-0 truncate">{row.title}</span>
            {row.citations > 1 ? <span className="flex-none text-ink-faint">×{row.citations}</span> : null}
            {/* the age is the reading's own timestamp, so it sits beside the word rather than under the
                title: "20d ago · Stale" is one observation, and the age alone was never the claim. */}
            <span className="flex-none text-ink-faint">{ageLabel(row.ageMs)}</span>
            <span className={cn("flex-none font-semibold", freshnessFg(row.freshness))}>
                {freshnessLabel(row.freshness)}
            </span>
        </SourceChip>
    );
}

// Pinned under the turns: what the whole thread drew on, which is the question you ask before trusting it.
function DrewBand({ conversation, model }: { conversation: JarvisConversation; model: AgentsViewModel }) {
    const { rows, meta } = drewOn(conversation);
    if (rows.length === 0) {
        // absence is a sentence, never a heading over an empty frame
        return (
            <div
                data-jarvis-brief-band="drew"
                className="flex-none border-t border-border bg-surface-raised px-[22px] py-2.5 text-[12.5px] text-secondary"
            >
                This thread cited nothing on file — nothing here is resting on a record.
            </div>
        );
    }
    return (
        <div
            data-jarvis-brief-band="drew"
            className="flex min-w-0 flex-none flex-wrap items-center gap-[9px] border-t border-border bg-surface-raised px-[22px] py-2.5"
        >
            <span className={BAND_LABEL}>Drew on</span>
            {rows.map((r) => (
                <DrewChip key={r.key} row={r} model={model} />
            ))}
            <span className="flex-1" />
            <span className="flex-none font-mono text-[9.5px] text-ink-faint">{meta}</span>
        </div>
    );
}

function BriefComposer({ model }: { model: AgentsViewModel }) {
    const [draft, setDraft] = useAtom(briefDraftAtom);
    const [thread, setThread] = useAtom(briefThreadAtom);
    const scope = useAtomValue(briefScopeAtom);
    const askState = useAtomValue(briefingAskStateAtom);
    const answer = useAtomValue(briefingAnswerAtom);
    // Who a keystroke reaches. The composer never moves, so the only thing that can change its meaning is
    // what the detail sheet is drawing — hence it reads the sheet's inputs rather than owning state.
    const agents = useAtomValue(model.agentsAtom);
    const subject = useAtomValue(activeSubjectAtom);
    const sheetRun = useAtomValue(stageRunAtom);
    const sheetOpen = useAtomValue(briefSheetOpenAtom);
    const footerRef = useRef<HTMLElement>(null);
    useEffect(() => {
        const el = footerRef.current;
        if (el == null) {
            return;
        }
        const observer = new ResizeObserver(() => globalStore.set(briefComposerHeightAtom, el.offsetHeight));
        observer.observe(el);
        return () => {
            observer.disconnect();
            globalStore.set(briefComposerHeightAtom, 0);
        };
    }, []);
    const channel = useAtomValue(activeChannelAtom);
    const projects = useAtomValue(projectsAtom);
    const effortCache = useAtomValue(effortDetailAtom);
    // a send that left Jarvis has no thread to land in, so its outcome is said here or nowhere
    const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

    const last = thread[thread.length - 1];
    const awaitingReply = last != null && last.turn.role === "user";
    const alreadyThreaded = answer != null && thread.some((e) => e.answer === answer);
    // an answer becomes a turn only while this thread is waiting for one, and only once: one that landed
    // before the thread opened, after Escape collapsed it, or under a failed ask belongs to no turn here.
    useEffect(() => {
        if (answer == null || askState !== "answered" || !awaitingReply || alreadyThreaded) {
            return;
        }
        setThread((t) => [
            ...t,
            { key: `a${t.length}:${Date.now()}`, ts: Date.now(), turn: answerTurn(answer), answer },
        ]);
    }, [answer, askState, awaitingReply, alreadyThreaded, setThread]);

    const asked = thread.filter((e) => e.turn.role === "user").length;
    const title = thread.length > 0 ? turnProse(thread[0].turn) : (scope.attached[0]?.title ?? "");
    const sourceChip = scope.chips.find((chip) => chip.active)?.label;
    const face = sheetFace(subject, sheetRun);
    const target = resolveBriefComposerTarget({
        sheetOpen,
        face,
        run: sheetRun,
        agents,
        projectName: channelProjectLabel(channel, projects),
        effortTitle: face.kind === "effort" ? effortCache.get(`effort:${face.effortId}`)?.title : undefined,
    });
    // `sheet` is briefcompose's third shape: an open drawer is a narrower context than the thread behind
    // it, so it wins. The target decides, not the sheet's openness — a drawer with nothing to talk to
    // resolves to the Brief, and then these labels must not claim otherwise.
    const state: BriefComposeState =
        target.audience === "worker"
            ? {
                  peek: "sheet",
                  kind: "session",
                  name: target.sessionName,
                  project: channelProjectLabel(channel, projects),
              }
            : target.audience === "initiative"
              ? { peek: "sheet", kind: "initiative", name: target.name }
              : thread.length === 0 && sourceChip == null
                ? { peek: "launch" }
                : { peek: "thread", title, turnCount: thread.length, sourceChip };
    const labels = resolveComposerLabels(state);
    const conversation: JarvisConversation = {
        id: "brief-ask",
        title,
        turns: thread.map((e) => e.turn),
        scope,
    };
    const answered = thread.some((e) => isAnswerTurn(e.turn));
    // held only while this thread's own question is still out — a second one would supersede the first ask
    // and leave the turn it belonged to unanswered. A pending ask from anywhere else is not this composer's
    // to hold, and a failed one must stay retryable, so neither disables it.
    // a directive goes straight into a terminal, so it is never "in flight" the way an ask is
    const inFlight = target.audience !== "worker" && awaitingReply && askState === "pending";
    const canSend = draft.trim() !== "" && !inFlight;

    const askJarvis = (text: string, scopedTo: string[]) => {
        setThread((t) => [
            ...t,
            { key: `q${t.length}:${Date.now()}`, ts: Date.now(), turn: userTurn(text, scope.attached) },
        ]);
        askAcrossWork(text, [...scopedTo, ...scope.attached.map((ref) => ref.oref)]);
    };

    const submit = () => {
        if (!canSend) {
            return;
        }
        const text = draft.trim();
        setDraft("");
        setStatus(null);
        if (target.audience === "worker") {
            fireAndForget(async () => {
                const sent = await steerWorker({
                    channelId: target.channelId,
                    workerORef: target.workerORef,
                    agents,
                    text,
                });
                if (!sent) {
                    // the roster moved between render and send: give the words back rather than eat them
                    setDraft(text);
                    setStatus({ tone: "error", text: `${target.workerName} is no longer live — nothing was sent.` });
                }
            });
            return;
        }
        askJarvis(text, target.audience === "initiative" ? [target.effortORef] : []);
    };

    // ⇧⏎: the standing rule the composer offers on a session sheet. It is a principle on the channel's
    // profile — the same list the profile modal edits — so the rule outlives the session that prompted it.
    const addStandingRule = () => {
        const text = draft.trim();
        if (target.audience !== "worker" || text === "") {
            return;
        }
        const { channelId, sessionName } = target;
        setDraft("");
        setStatus(null);
        fireAndForget(async () => {
            try {
                const profile = await getJarvisProfile(channelId);
                const override = profile.override ?? {};
                const principles = reducePrinciplePatch(override.principles, {
                    type: "add",
                    principle: { id: `project-${crypto.randomUUID()}`, text },
                });
                await setChannelProfile(channelId, { ...override, principles });
                // the resolved cache is what future runs read; a stale one would describe a rule that is
                // saved but not yet in force.
                await refreshResolvedProfile(channelId);
                setStatus({ tone: "ok", text: `Standing rule saved for ${sessionName}. It applies to future runs.` });
            } catch (e) {
                setDraft(text);
                setStatus({ tone: "error", text: String(e) });
            }
        });
    };

    // local to the input, never a window listener: the Brief adds no global chord of its own.
    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        // gated on the label, not on the target, so the offer and the behaviour cannot disagree
        if (e.key === "Enter" && e.shiftKey && labels.alt != null) {
            e.preventDefault();
            addStandingRule();
            return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
            return;
        }
        if (e.key === "Escape" && thread.length > 0) {
            e.preventDefault();
            clearBriefThread();
        }
    };

    return (
        <>
            {thread.length > 0 ? (
                <div
                    data-jarvis-brief-thread
                    className="flex max-h-[54vh] min-h-0 flex-none flex-col border-t border-edge-strong bg-surface"
                >
                    <div className="flex min-w-0 flex-none items-center gap-2.5 border-b border-border px-[22px] py-2.5">
                        <span className={cn(TURN_WHO, "text-accent-soft")}>Thread</span>
                        <span className="min-w-0 truncate text-[13px] font-semibold text-ink-hi">{title}</span>
                        <span className="flex-none font-mono text-[10px] text-muted">
                            {asked} {asked === 1 ? "question" : "questions"}
                        </span>
                        <span className="flex-1" />
                        <button
                            type="button"
                            onClick={clearBriefThread}
                            className="flex-none cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2 py-0.5 font-mono text-[10px] font-semibold text-muted hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            Collapse · esc
                        </button>
                    </div>
                    <div
                        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] py-3.5"
                        aria-live="polite"
                    >
                        {/* opacity only, and no layout: these wrap prose that streams in, and animating
                            layout on streaming text is the perf trap the cockpit spec names. initial={false}
                            so reopening a restored thread does not replay every turn. */}
                        <AnimatePresence initial={false}>
                            {thread.map((e) => (
                                <motion.div
                                    key={e.key}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                                >
                                    <TurnView exchange={e} model={model} />
                                </motion.div>
                            ))}
                        </AnimatePresence>
                        {inFlight ? (
                            <div className="flex items-center gap-[9px]">
                                <span className={cn(TURN_WHO, "text-accent-soft")}>Jarvis</span>
                                <span className="font-mono text-[12px] text-ink-faint">reading across your work</span>
                            </div>
                        ) : null}
                        {askState === "error" && awaitingReply ? (
                            <span className="text-[12.5px] text-secondary">Ask failed — try again.</span>
                        ) : null}
                    </div>
                    <AnimatePresence initial={false}>
                        {answered ? (
                            <motion.div
                                key="drew"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                            >
                                <DrewBand conversation={conversation} model={model} />
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                </div>
            ) : null}
            {/* z-30 clears the detail sheet's backdrop. The sheet dims and covers the ground on purpose,
                but the composer is not ground: its whole contract is that it stays reachable and retargets
                to whatever the sheet opened on, which a backdrop over it would make impossible. */}
            <footer
                ref={footerRef}
                data-jarvis-brief-band="composer"
                className="relative z-30 flex-none border-t border-edge-faint bg-surface px-[22px] pb-4 pt-2.5"
            >
                <div className="flex flex-col gap-2.5 rounded-[9px] border border-border bg-surface-raised px-[15px] py-3 focus-within:border-edge-strong">
                    <input
                        data-jarvis-brief-composer="input"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={onKey}
                        placeholder={labels.hint}
                        aria-label={labels.hint}
                        className="h-6 w-full min-w-0 border-0 bg-transparent text-[13.5px] text-ink-hi placeholder:text-ink-faint focus:outline-none"
                    />
                    <div className="flex min-w-0 flex-wrap items-center gap-[9px]">
                        <span data-jarvis-brief-composer="scope" className={cn(COMPOSER_CHIP, "text-accent-soft")}>
                            {labels.scope}
                        </span>
                        {labels.alt != null ? (
                            <span data-jarvis-brief-composer="alt" className={cn(COMPOSER_CHIP, "text-muted")}>
                                {labels.alt}
                            </span>
                        ) : null}
                        <span className="flex-1" />
                        <button
                            type="button"
                            data-jarvis-brief-composer="send"
                            onClick={submit}
                            disabled={!canSend}
                            className="flex-none rounded-[6px] border border-edge-strong px-3.5 py-1.5 text-[12px] font-semibold text-accent-soft enabled:cursor-pointer hover:border-accent hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:border-border disabled:text-ink-faint"
                        >
                            {labels.action}
                        </button>
                    </div>
                    {status != null ? (
                        <span
                            data-jarvis-brief-composer="status"
                            aria-live="polite"
                            className={cn("text-[11.5px]", status.tone === "ok" ? "text-success" : "text-error")}
                        >
                            {status.text}
                        </span>
                    ) : null}
                </div>
            </footer>
        </>
    );
}

export function BriefSurface({ model }: { model: AgentsViewModel }) {
    // the briefing pipeline, unchanged from briefingview: one load per entry, a dwell-gated visit ack,
    // the memoized projection, the DEV fixture seam, and the live attention read.
    const { snapshot, loading, error } = useAtomValue(briefingStateAtom);
    const fixture = useAtomValue(briefingFixtureAtom);
    const liveAgents = useAtomValue(model.agentsAtom);
    const liveAttention = useAtomValue(attentionAtom);

    useEffect(() => {
        loadBriefing();
    }, []);

    // DEV-only: the resource-linking scenario's seams (linkingdevhooks.ts)
    useEffect(() => {
        if (import.meta.env.DEV) {
            void import("./linkingdevhooks").then((m) => m.installLinkingDevHooks(model));
        }
    }, [model]);

    // The lists the Brief's boot restore validates against. Loaded here rather than inherited: in the Brief
    // composition the Subjects column does not mount, and that column is what loads both of these today.
    useEffect(() => {
        loadTaskList();
        loadJarvisConversations();
        // channels, because a Radar draft names a project and the landing has to resolve it to a channel
        loadChannels();
    }, []);

    // A Radar draft moved off the Stage with the panes it drew. It is one-shot — `landed` bounds it to a single
    // attempt, because a channel that never resolves must not re-fire on every change and yank the user back.
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
    const setPendingDraft = useSetAtom(pendingRunDraftAtom);
    const channels = useAtomValue(channelsAtom);

    // Radar "Start investigation": put its project's channel on the subject, so the sheet opens on that
    // channel's launcher holding the draft rather than dropping it on the queue.
    useEffect(() => {
        if (pendingDraft == null || pendingDraft.landed) {
            return;
        }
        const target = resolveTargetChannel(channels ?? [], pendingDraft.projectPath);
        if (target != null) {
            void openChannelSheet(target.oid, null);
        }
        setPendingDraft({ ...pendingDraft, landed: true });
    }, [pendingDraft, channels, setPendingDraft]);

    // Boot restore, Brief edition. A subject stored by the three-pane composition has no Stage to land on
    // here, so it lands on the peek or in the composer instead (briefrestore.ts). One-shot: this surface
    // unmounts on every nav switch, and a restore that re-ran would re-open a peek the user had closed.
    const storedSubject = useAtomValue(persistedSubjectAtom);
    const dossiers = useAtomValue(taskListAtom);
    const summaries = useAtomValue(persistedSummariesAtom);
    const conversations = useAtomValue(conversationsByIdAtom);
    const [restoreConsumed, consumeRestore] = useAtom(briefRestoreConsumedAtom);
    // the conversation half of the restore, held between the decision and its turns arriving
    const [restoreConversationId, setRestoreConversationId] = useState<string | null>(null);

    useEffect(() => {
        if (restoreConsumed) {
            return;
        }
        const plan = briefRestorePlan(storedSubject, {
            // channels included: a stored channel now lands on its own sheet, so the restore has to be able
            // to tell "that channel is gone" from "the list has not arrived"
            channels: channels?.map((c) => c.oid) ?? null,
            dossiers: dossiers?.map((d) => d.id) ?? null,
            conversations: summaries == null ? null : summaries.map((s) => s.id),
        });
        if (plan.action === "wait") {
            return;
        }
        consumeRestore(true);
        if (plan.action === "record") {
            globalStore.set(briefPeekRecordAtom, plan.id);
            return;
        }
        if (plan.action === "conversation") {
            setRestoreConversationId(plan.id);
            selectConversation(plan.id);
            return;
        }
        if (plan.action === "channel") {
            void openChannelSheet(plan.id, null);
            return;
        }
        globalStore.set(persistedSubjectAtom, null);
    }, [storedSubject, dossiers, summaries, channels, restoreConsumed, consumeRestore]);

    useEffect(() => {
        if (restoreConversationId == null) {
            return;
        }
        const convo = conversations[restoreConversationId];
        // the summary is where the turns' one available timestamp comes from; without it there is no honest
        // age to print, and the thread was deleted between the decision and its load anyway
        const summary = summaries?.find((s) => s.id === restoreConversationId);
        if (convo == null || summary == null) {
            return;
        }
        setRestoreConversationId(null);
        // a thread the user started while this was loading is theirs, not the restore's to discard
        if (globalStore.get(briefThreadAtom).length > 0 || globalStore.get(briefDraftAtom) !== "") {
            return;
        }
        hydrateBriefThread(convo, summary.updatedts);
    }, [restoreConversationId, conversations, summaries]);

    // dwell, not load: a glance-and-close must leave the delta unseen so it repeats on the next visit.
    const snapshotComplete = snapshot?.complete === true;
    const queryStartedAt = snapshot?.queryStartedAt;
    useEffect(() => {
        if (!snapshotComplete) {
            return;
        }
        const t = window.setTimeout(ackBriefingVisit, 3000);
        return () => window.clearTimeout(t);
    }, [snapshotComplete, queryStartedAt]);

    const agents = fixture != null ? BRIEFING_FIXTURES[fixture].agents : liveAgents;
    // the plan-gate modal reads the roster out of this atom, and the Stage was its only writer
    useEffect(() => {
        setDagModalAgentsContext(model, agents);
    }, [model, agents]);
    const model_ = useMemo(() => {
        if (snapshot == null) {
            return null;
        }
        return projectBriefing({
            state: snapshot.state,
            agents,
            actualCursor: snapshot.actualCursor,
            queryStartedAt: snapshot.queryStartedAt,
            sevenDaysAgo: snapshot.queryStartedAt - SEVEN_DAYS_MS,
        });
    }, [snapshot, agents]);

    // a fixture seeds attention the same way it seeds the roster, so every fixture previews the queue.
    const attention = fixture != null ? BRIEFING_FIXTURES[fixture].attention : liveAttention;
    // memoized because the j/k controller below is registered per identity: recomputing these every
    // render would re-register it every render. They are pure functions of the snapshot projection, so
    // pinning them to it also stops groupDelta's "now" drifting between renders of the same snapshot.
    const queue = useMemo(
        () => (model_ != null ? buildAttentionQueue({ attention, efforts: model_.efforts }) : []),
        [model_, attention]
    );
    // the full projection, not the window: a blocked chunk on the seventh initiative is still waiting on
    // you, so the queue reads every effort even when the Initiatives region is only showing six.
    const efforts = useMemo(() => model_?.efforts ?? [], [model_]);

    // Each region opens at its cap and the region's own control opens the rest in place. The caps stay
    // display-side so the overflow count is what was actually hidden from the rows above it.
    const [expanded, setExpanded] = useAtom(briefExpandedAtom);
    const toggleRegion = useCallback(
        (id: RegionId) => setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true })),
        [setExpanded]
    );
    const waitingOpen = expanded.waiting === true;
    const initiativesOpen = expanded.initiatives === true;
    const sessionsOpen = expanded.sessions === true;
    const behindOpen = expanded.behind === true;
    const queueSummary = useMemo(() => summarizeAttentionQueue(queue), [queue]);

    const effortWindow = useMemo(() => capRegion(efforts, EFFORT_CAP, initiativesOpen), [efforts, initiativesOpen]);
    const sessions = useMemo(
        () => (model_ == null ? { rows: [], more: 0 } : sessionWindow(model_, sessionsOpen, Date.now())),
        [model_, sessionsOpen]
    );
    // moment 1: which rows are new to YOU. Excludes `behind` deliberately — that region is entirely
    // since-your-last-visit by construction, so marking it would mark every row and its own label
    // already states the fact.
    const cursorTs = snapshot?.actualCursor ?? 0;
    const freshWaiting = useMemo(
        () =>
            freshKeys(
                queue.map((q) => ({ key: q.key, ts: q.ts })),
                cursorTs
            ),
        [queue, cursorTs]
    );
    const freshInitiatives = useMemo(
        () =>
            freshKeys(
                effortWindow.rows.map((e) => ({ key: e.oref, ts: e.updatedts })),
                cursorTs
            ),
        [effortWindow, cursorTs]
    );
    const freshSessions = useMemo(
        () =>
            freshKeys(
                sessions.rows.map((r) => ({ key: r.key, ts: r.ts })),
                cursorTs
            ),
        [sessions, cursorTs]
    );

    // moment 2: only ids that arrive while the snapshot's identity is unchanged animate in. A refresh
    // reseeds silently, which is what stops a whole-snapshot swap from firing N entrances at once; the
    // live attention poll still lands a new waiting row against an unchanged key. Committed in a layout
    // effect rather than during render because the render pass can run twice (motiontokens.ts).
    const entranceIds = [
        ...queue.map((q) => q.key),
        // every effort rather than the window: opening the region is not news arriving, so the rows it
        // adds must not animate in as if they had
        ...efforts.map((e) => e.oref),
        ...sessions.rows.map((r) => r.key),
    ];
    const entranceKey = snapshot?.queryStartedAt?.toString();
    const entranceRef = useRef(initialEntranceState());
    const { animate: entering } = computeEntrances(entranceRef.current, entranceKey, entranceIds);
    const entranceIdsKey = entranceIds.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, entranceKey, entranceIds).state;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entranceIdsKey, entranceKey]);

    const deltaWindow = useMemo(() => capRegion(model_?.delta ?? [], DELTA_CAP, behindOpen), [model_, behindOpen]);
    const deltaGroups = useMemo(() => groupDelta(deltaWindow.rows, Date.now()), [deltaWindow]);
    const shipped = useMemo(() => capRegion(model_?.shipped ?? [], SHIPPED_CAP, behindOpen), [model_, behindOpen]);

    // The filter and the one-region view narrow what is drawn, and the nav ids are the drawn lines' own, so
    // j/k can never land on a row the filter hid.
    const [query, setQuery] = useState("");
    const [only, setOnly] = useState<RegionId | null>(null);
    const [staleOpen, setStaleOpen] = useAtom(briefStaleOpenAtom);
    const toggleOnly = (id: RegionId) => setOnly((cur) => (cur === id ? null : id));
    const filtering = query.trim() !== "";
    const lines = useMemo(() => {
        const now = Date.now();
        return {
            waiting: filterLines(
                queue.map((q) => queueLine(q, now)),
                query
            ),
            initiatives: filterLines(effortWindow.rows.map(initiativeLine), query),
            sessions: filterLines(
                sessions.rows.map((r) => sessionLine(r, now)),
                query
            ),
            behind: behindGroups(deltaGroups, shipped.rows, now)
                .map((g) => ({ ...g, lines: filterLines(g.lines, query) }))
                .filter((g) => g.lines.length > 0),
        };
    }, [queue, effortWindow, sessions, deltaGroups, shipped, query]);
    const staleCount = lines.sessions.filter((l) => l.stale).length;
    const waitingShown = waitingOpen || filtering;
    const view = useMemo(() => {
        const shows = (id: RegionId) => only == null || only === id;
        // a search reaches the folded runs too: a match hidden behind the fold would read as no match
        const sessionLines = staleOpen || filtering ? lines.sessions : lines.sessions.filter((l) => !l.stale);
        const visible: BriefLine[] = [
            ...(shows("waiting") && waitingShown ? lines.waiting : []),
            ...(shows("initiatives") ? lines.initiatives : []),
            ...(shows("sessions") ? sessionLines : []),
            ...(shows("behind") ? lines.behind.flatMap((g) => g.lines) : []),
        ];
        return { shows, sessionLines, visible };
    }, [lines, only, staleOpen, filtering, waitingShown]);

    // --- inline tracker -----------------------------------------------------------------------------
    // The expanded initiative's plan is spliced into the SAME row list the cursor walks, so j/k falls
    // into the chunks and back out. A second ↑/↓ handler here would be a second cursor fighting the first.
    const [openInitiative, setOpenInitiative] = useAtom(openInitiativeAtom);
    const [stageOverrides, setStageOverrides] = useAtom(stageOverridesAtom);
    const [noteChunk, setNoteChunk] = useAtom(noteChunkAtom);
    const [readingNote, setReadingNote] = useAtom(readingNoteAtom);
    const effortCache = useAtomValue(effortDetailAtom);
    const expandedLine = view.visible.find((l) => l.id === openInitiative) ?? null;
    const openEffortORef = expandedLine != null ? expandableORef(expandedLine) : null;
    const openEffort = openEffortORef != null ? (effortCache.get(openEffortORef) ?? null) : null;
    // the freshest updatedts the app knows, so a chunk ticked by `wsh effort` out of band still refreshes
    const openCard = efforts.find((e) => e.oref === openEffortORef) ?? null;
    const openFreshTs = openCard?.updatedts;
    useEffect(() => {
        if (openEffortORef == null) {
            return;
        }
        // a failure here leaves the row expanded on its "loading" line rather than collapsing under the
        // click; the next snapshot refresh retries.
        fireAndForget(() => loadEffortDetail(openEffortORef, openFreshTs));
    }, [openEffortORef, openFreshTs]);

    const tracker = useMemo(() => {
        const feed = openEffort != null ? effortFeed(openEffort) : [];
        const rows = trackerRows({
            lines: view.visible,
            openLineId: openInitiative,
            chunks: openEffort != null ? effortChunkRows(openEffort) : null,
            noteCounts: feedNoteCounts(feed),
            countLine: openCard?.countLine ?? "",
            stageOverrides,
        });
        return {
            rows,
            feed,
            navIds: trackerNavIds(rows),
            detail: rows.filter((r): r is DetailRow => r.kind !== "line"),
        };
    }, [view.visible, openInitiative, openEffort, openCard, stageOverrides]);

    const [storedCursor, setStoredCursor] = useAtom(briefCursorAtom);
    const cursor = resolveBriefCursor(tracker.navIds, storedCursor);
    // cursor == selection: landing on a chunk is what shows its notes, so j/k reads the plan as it walks.
    const setCursor = useCallback(
        (id: string) => {
            setStoredCursor(id);
            if (id.includes("/chunk:")) {
                setNoteChunk(id);
                setReadingNote(null);
            }
        },
        [setStoredCursor, setNoteChunk, setReadingNote]
    );
    const selected = tracker.rows.find((r) => r.kind === "chunk" && r.id === noteChunk);
    const selectedChunk = selected?.kind === "chunk" ? selected : null;
    const closeNotes = useCallback(() => {
        setNoteChunk(null);
        setReadingNote(null);
    }, [setNoteChunk, setReadingNote]);

    // Every write goes through here so a failure is SHOWN rather than swallowed: the mutate helpers
    // write through and refresh the briefing's summary leg, and a rejected op would otherwise leave the
    // row looking unchanged with no explanation.
    const [mutateError, setMutateError] = useState<string | null>(null);
    const runMutation = useCallback((fn: () => Promise<void>) => {
        setMutateError(null);
        fn().catch((e) => setMutateError(e instanceof Error ? e.message : String(e)));
    }, []);
    const sheetOpen = useAtomValue(briefSheetOpenAtom);
    const openLine = useCallback(
        (target: LineTarget) => {
            if (target == null) {
                return;
            }
            if ("queue" in target) {
                const queue = target.queue;
                fireAndForget(() =>
                    queue.kind === "channel"
                        ? openTarget(model, {
                              kind: "channel",
                              channelId: queue.channelId,
                              runId: queue.runId ?? undefined,
                          })
                        : openAddress(model, queue.oref)
                );
                return;
            }
            fireAndForget(() => openAddress(model, target.oref));
        },
        [model]
    );
    const cursorRow = tracker.rows.find((r) => r.id === cursor) ?? null;
    const cursorTarget = cursorRow?.kind === "line" ? cursorRow.line.target : null;
    // Enter's primary action, by what the cursor is on: an initiative expands in place (it no longer has
    // a sheet to open), a chunk opens its newest note in the reader, every other row opens its target.
    const toggleInitiative = useCallback(
        (lineId: string) => {
            setOpenInitiative((cur) => (cur === lineId ? null : lineId));
            setNoteChunk(null);
            setReadingNote(null);
        },
        [setOpenInitiative, setNoteChunk, setReadingNote]
    );
    const activateCursor = useCallback(() => {
        if (cursorRow == null) {
            return;
        }
        if (cursorRow.kind === "chunk") {
            setNoteChunk(cursorRow.id);
            setReadingNote(0);
            return;
        }
        if (cursorRow.kind === "line" && expandableORef(cursorRow.line) != null) {
            toggleInitiative(cursorRow.id);
            return;
        }
        if (cursorTarget != null) {
            openLine(cursorTarget);
        }
    }, [cursorRow, cursorTarget, openLine, setNoteChunk, setReadingNote, toggleInitiative]);
    // j/k across every region in render order, and Enter opens the row under the cursor. Enter is left alone
    // while a sheet is open, because the sheet's own Enter (an ask's submit) is the one on screen, and on a
    // row that opens nothing, so the key passes through. Typing never reaches here: list keys are off in a field.
    useSurfaceListNav(
        useMemo<ListNavController>(
            () => ({
                surface: "jarvis",
                navigableIds: tracker.navIds,
                cursorId: cursor,
                setCursor,
                activate: sheetOpen || cursorRow == null ? undefined : activateCursor,
            }),
            [tracker.navIds, cursor, setCursor, sheetOpen, cursorRow, activateCursor]
        )
    );
    // the four regions scroll as one column, so a cursor moved off-screen has to be brought back
    useEffect(() => {
        document.querySelector('[data-jarvis-brief-cursor="true"]')?.scrollIntoView({ block: "nearest" });
    }, [cursor]);

    const fleet = briefFleet(agents);

    // The profile modal is Brief-local state. The detail sheet is not: it draws the surface's active
    // subject, so what is open lives in the subject store and this surface only reports it.
    const [profileOpen, setProfileOpen] = useState(false);

    // The surface's own keys: new thread, the run switcher, the record band, the composer's i/Escape, and
    // the graph peek. The Stage used to register these for a composition that no longer exists.
    const jarvisBindings = useMemo(() => buildJarvisBindings(), []);
    useKeybindings(jarvisBindings);

    // Where the graph peek opens. The Brief has no Stage subject, so the derivation starts from what the
    // Brief itself is about: the record the peek's map button named, else the thread's attached sources,
    // else the records its answers cited. peekFocus already implements that order, so this names no second
    // one. tagsFor is real rather than empty because an attached RUN source resolves to a record only
    // through the ambient attribution map, and an empty one would silently focus nothing.
    const graphRecord = useAtomValue(briefGraphRecordAtom);
    const graphOpen = useAtomValue(graphPeekOpenAtom);
    const scope = useAtomValue(briefScopeAtom);
    const thread = useAtomValue(briefThreadAtom);
    const ambient = useAtomValue(ambientProviderAtom);
    useEffect(() => ensureAmbient(), []);
    const graphFocus = useMemo<PeekFocus>(
        () =>
            graphRecord != null
                ? { dossierId: graphRecord, runORef: null }
                : peekFocus({
                      subject: null,
                      runORef: null,
                      attachedORefs: scope.attached.map((a) => a.oref),
                      mentionedDossierIds: mentionedDossierIds({
                          id: "brief-ask",
                          title: "",
                          turns: thread.map((e) => e.turn),
                          scope,
                      }),
                      tagsFor: (oref) => ambient.tagsFor({ oref }),
                  }),
        [graphRecord, scope, thread, ambient]
    );
    // closing clears the explicit record too: leaving it set would re-centre every later open on a record
    // the user has moved on from
    const closeBriefGraph = () => {
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(briefGraphRecordAtom, null);
    };
    const projectCount = snapshot?.state.projects?.length ?? 0;
    const stalled = efforts.filter((e) => e.blockedChunks.length > 0).length;
    // the true total, not the window's: a region meta that shrank back when you collapsed it would be
    // describing the control rather than the work.
    const pastRows = (model_?.delta.length ?? 0) + (model_?.shipped.length ?? 0);
    const pastMore = deltaWindow.more + shipped.more;
    const firstLoad = snapshot == null && loading;
    const loadFailed = snapshot == null && error != null;
    const staleSnapshot = snapshot != null && error != null;

    return (
        <div data-jarvis-region="brief" className="absolute inset-0 flex flex-col bg-background">
            <header className="flex h-[54px] flex-none items-center gap-2.5 border-b border-edge-faint bg-surface px-[22px]">
                <span aria-hidden className="font-mono text-[12px] font-semibold text-accent-soft">
                    ◈
                </span>
                <span className="flex-none text-[15px] font-bold tracking-[-.01em] text-ink-hi">Jarvis</span>
                {projectCount > 0 ? (
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">
                        all work · {projectCount} {projectCount === 1 ? "project" : "projects"}
                    </span>
                ) : null}
                <span className="flex-1" />
                <label className="flex h-[27px] w-[200px] flex-none items-center gap-2 rounded-[8px] border border-border px-2.5 focus-within:border-accent/60">
                    <span aria-hidden className="flex-none font-mono text-[10px] font-medium text-ink-faint">
                        /
                    </span>
                    <input
                        data-jarvis-brief-filter
                        aria-label="Filter the Brief"
                        placeholder="filter"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                setQuery("");
                                e.currentTarget.blur();
                            }
                        }}
                        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink-hi outline-none placeholder:text-ink-faint"
                    />
                    {filtering ? (
                        <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                            {view.visible.length} {view.visible.length === 1 ? "hit" : "hits"}
                        </span>
                    ) : null}
                </label>
                {/* the chip needs a snapshot: "all clear" over a load that has not landed is a lie */}
                {model_ != null ? (
                    <span
                        data-jarvis-brief-band="waiting"
                        className={cn(
                            "flex flex-none items-center gap-[7px] rounded-[6px] border px-2.5 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[.06em] transition-colors duration-[140ms]",
                            queue.length === 0
                                ? "border-success/30 bg-success/15 text-success"
                                : "border-asking/30 bg-asking/15 text-asking"
                        )}
                    >
                        <span
                            className={cn(
                                "h-[5px] w-[5px] flex-none rounded-full transition-colors duration-[140ms]",
                                queue.length === 0
                                    ? "bg-success"
                                    : "animate-[pulseDot_1.8s_ease-in-out_infinite] bg-asking motion-reduce:animate-none"
                            )}
                        />
                        {queue.length === 0 ? (
                            "all clear"
                        ) : (
                            <span className="flex items-center gap-1">
                                <RollingCount value={queue.length} /> waiting
                            </span>
                        )}
                    </span>
                ) : null}
                <span data-jarvis-brief-band="fleet" className="flex-none font-mono text-[10px] text-muted">
                    {fleet.line}
                </span>
                {/* the remote-approval policy, and the one header item that is a summary rather than a
                    reading: the tier is per-channel in the backend, so the chip states what every project
                    agrees on and the popover it opens edits them one at a time. */}
                <AutonomyLadder channels={channels} />
                {/* A real control with the control recipe's border: invariant 4 forbids camouflaging it among
                    the status chips above, which are borderless labels. */}
                <button
                    type="button"
                    data-jarvis-brief-profile
                    aria-expanded={profileOpen}
                    onClick={() => setProfileOpen(true)}
                    className="flex-none cursor-pointer rounded-[6px] border border-border px-2.5 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[.06em] text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    Profile
                </button>
                <NewInitiativeControl />
                <NewRunControl model={model} />
            </header>
            {/* both bands push the surface down, so height belongs in the animation rather than a cut */}
            <AnimatePresence initial={false}>
                {staleSnapshot ? (
                    <motion.div
                        key="stale"
                        variants={paneReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        data-jarvis-brief-band="stale"
                        className="flex flex-none items-center gap-2 overflow-hidden border-b border-edge-faint px-[22px] py-1 font-mono text-[10px] text-error"
                    >
                        <span aria-hidden className="font-bold">
                            ✕
                        </span>
                        refresh failed — showing the previous snapshot
                    </motion.div>
                ) : null}
            </AnimatePresence>
            {/* @container, not a media query: the sidebar's width rule is about how much SURFACE the
                index has left, and the window is not the surface. */}
            <div className="@container relative flex min-h-0 flex-1">
                <div
                    className={cn(
                        "flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-[22px] pb-2.5 pt-5",
                        // the index reserves the PREVIEW's width and does not reflow when a note opens;
                        // only the wide band lets the reader push it further.
                        selectedChunk != null && "pr-[380px]",
                        selectedChunk != null && readingNote != null && "@min-[1281px]:pr-[580px]"
                    )}
                    aria-live="polite"
                >
                    <AnimatePresence initial={false}>
                        {loadFailed ? (
                            <motion.div
                                key="load-error"
                                variants={paneReveal}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                data-jarvis-brief-state="error"
                                className="flex flex-col gap-2 overflow-hidden rounded-[10px] border border-border bg-surface px-4 py-3"
                            >
                                <span className="text-[13px] font-semibold text-ink-hi">
                                    Couldn't load your work state.
                                </span>
                                <span className="text-[12px] text-secondary">{error}</span>
                                <button
                                    type="button"
                                    onClick={refreshBriefing}
                                    className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    Retry
                                </button>
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                    {/* mode="wait" so the skeleton is gone before the regions arrive: the two cross-faded in
                    place would read as a double exposure of the same four headings. The skeleton blocks'
                    own animate-pulse is unchanged. */}
                    <AnimatePresence mode="wait" initial={false}>
                        {firstLoad ? (
                            <motion.div
                                key="skeleton"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                                data-jarvis-brief-state="loading"
                                className="flex flex-col gap-[26px]"
                            >
                                {Object.entries(REGIONS).map(([id, r]) => (
                                    <div key={id} className="flex flex-col gap-2">
                                        <span className={cn(REGION_LABEL, "text-feed-label")}>{r.label}</span>
                                        <div className="h-12 animate-pulse rounded-[10px] bg-surface motion-reduce:animate-none" />
                                    </div>
                                ))}
                            </motion.div>
                        ) : null}
                        {model_ != null ? (
                            <motion.div
                                key="regions"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                                className="flex flex-col gap-[26px]"
                            >
                                {view.shows("waiting") ? (
                                    <Region
                                        id="waiting"
                                        alert={queue.length > 0}
                                        count={queue.length > 0 ? queue.length : undefined}
                                        empty={queue.length === 0}
                                        gap="gap-[9px]"
                                        meta={
                                            !waitingOpen && queueSummary?.oldestTs != null
                                                ? `oldest ${formatAge(Date.now() - queueSummary.oldestTs)}`
                                                : "gates before asks"
                                        }
                                        only={only === "waiting"}
                                        onOnly={() => toggleOnly("waiting")}
                                    >
                                        {queueSummary != null ? (
                                            <div className="flex flex-col gap-[9px]">
                                                <QueueSummaryView
                                                    summary={queueSummary}
                                                    count={queue.length}
                                                    expanded={waitingOpen}
                                                    error={queue.some((q) => q.tone === "error")}
                                                    onToggle={() => toggleRegion("waiting")}
                                                />
                                                <MotionConfig reducedMotion="user">
                                                    <AnimatePresence initial={false}>
                                                        {waitingShown ? (
                                                            <motion.div
                                                                id="jarvis-attention-details"
                                                                key="attention-details"
                                                                variants={paneReveal}
                                                                initial="initial"
                                                                animate="animate"
                                                                exit="exit"
                                                                className="flex flex-col overflow-hidden"
                                                            >
                                                                {lines.waiting.length === 0 ? <NoMatch /> : null}
                                                                {lines.waiting.map((l) => (
                                                                    <motion.div
                                                                        key={l.id}
                                                                        layout
                                                                        variants={cardVariants}
                                                                        initial={
                                                                            entering.has(keyOf(l)) ? "initial" : false
                                                                        }
                                                                        animate="animate"
                                                                        exit="exit"
                                                                        transition={{
                                                                            duration: MOTION.durMacro,
                                                                            ease: MOTION.easeFluid,
                                                                        }}
                                                                    >
                                                                        <LineRow
                                                                            line={l}
                                                                            hook="queue"
                                                                            focused={cursor === l.id}
                                                                            fresh={freshWaiting.has(keyOf(l))}
                                                                            onOpen={
                                                                                l.target != null
                                                                                    ? () => openLine(l.target)
                                                                                    : undefined
                                                                            }
                                                                        />
                                                                    </motion.div>
                                                                ))}
                                                            </motion.div>
                                                        ) : null}
                                                    </AnimatePresence>
                                                </MotionConfig>
                                            </div>
                                        ) : null}
                                    </Region>
                                ) : null}
                                {view.shows("initiatives") ? (
                                    <Region
                                        id="initiatives"
                                        count={efforts.length}
                                        empty={efforts.length === 0}
                                        gap="gap-[9px]"
                                        meta={stalled > 0 ? `${stalled} stalled` : "all moving"}
                                        only={only === "initiatives"}
                                        onOnly={() => toggleOnly("initiatives")}
                                    >
                                        <div className="flex flex-col">
                                            {lines.initiatives.length === 0 ? <NoMatch /> : null}
                                            <MotionConfig reducedMotion="user">
                                                <AnimatePresence initial={false}>
                                                    {lines.initiatives.map((l) => (
                                                        <motion.div
                                                            key={l.id}
                                                            // position, not full layout: the pane below owns its own height
                                                            // animation, and a size-animating parent would re-project that
                                                            // growth as a scale — stretching the rows it just revealed.
                                                            layout="position"
                                                            variants={cardVariants}
                                                            initial={entering.has(keyOf(l)) ? "initial" : false}
                                                            animate="animate"
                                                            exit="exit"
                                                            transition={{
                                                                duration: MOTION.durMacro,
                                                                ease: MOTION.easeFluid,
                                                            }}
                                                        >
                                                            <LineRow
                                                                line={l}
                                                                hook="initiative"
                                                                focused={cursor === l.id}
                                                                fresh={freshInitiatives.has(keyOf(l))}
                                                                expanded={l.id === openInitiative}
                                                                onOpen={() => {
                                                                    setCursor(l.id);
                                                                    toggleInitiative(l.id);
                                                                }}
                                                            />
                                                            {/* the plan reveal: height+opacity on the macro duration, and NOT a
                                                                layout node, so the reveal and the list's reflow don't fight. */}
                                                            <AnimatePresence initial={false}>
                                                                {l.id === openInitiative ? (
                                                                    <motion.div
                                                                        key="detail"
                                                                        variants={paneReveal}
                                                                        initial="initial"
                                                                        animate="animate"
                                                                        exit="exit"
                                                                        className="overflow-hidden"
                                                                    >
                                                                        <InitiativeDetail
                                                                            rows={tracker.detail}
                                                                            cursor={cursor}
                                                                            onSelectChunk={(id) => {
                                                                                setCursor(id);
                                                                                setNoteChunk(id);
                                                                                setReadingNote(null);
                                                                            }}
                                                                            archived={openCard?.status === "archived"}
                                                                            onToggleStage={(id, open) =>
                                                                                setStageOverrides((cur) => ({
                                                                                    ...cur,
                                                                                    [id]: open,
                                                                                }))
                                                                            }
                                                                            onAddChunk={(label) => {
                                                                                if (openEffortORef != null) {
                                                                                    runMutation(() =>
                                                                                        addChunkOp(
                                                                                            openEffortORef,
                                                                                            label
                                                                                        )
                                                                                    );
                                                                                }
                                                                            }}
                                                                            onArchive={() => {
                                                                                if (openEffortORef != null) {
                                                                                    runMutation(() =>
                                                                                        setEffortStatus(
                                                                                            openEffortORef,
                                                                                            "archived"
                                                                                        )
                                                                                    );
                                                                                }
                                                                            }}
                                                                        />
                                                                    </motion.div>
                                                                ) : null}
                                                            </AnimatePresence>
                                                        </motion.div>
                                                    ))}
                                                </AnimatePresence>
                                            </MotionConfig>
                                            <MoreControl
                                                n={effortWindow.more}
                                                expanded={initiativesOpen}
                                                onToggle={() => toggleRegion("initiatives")}
                                            />
                                        </div>
                                    </Region>
                                ) : null}
                                {view.shows("sessions") ? (
                                    <Region
                                        id="sessions"
                                        empty={sessions.rows.length === 0}
                                        gap="gap-[9px]"
                                        meta={
                                            staleCount > 0 && !staleOpen && !filtering
                                                ? `${staleCount} stale hidden`
                                                : "run on their own"
                                        }
                                        only={only === "sessions"}
                                        onOnly={() => toggleOnly("sessions")}
                                    >
                                        <div className="flex flex-col">
                                            {filtering && view.sessionLines.length === 0 ? <NoMatch /> : null}
                                            <MotionConfig reducedMotion="user">
                                                <AnimatePresence initial={false}>
                                                    {view.sessionLines.map((l) => (
                                                        <motion.div
                                                            key={l.id}
                                                            layout
                                                            variants={cardVariants}
                                                            initial={entering.has(keyOf(l)) ? "initial" : false}
                                                            animate="animate"
                                                            exit="exit"
                                                            transition={{
                                                                duration: MOTION.durMacro,
                                                                ease: MOTION.easeFluid,
                                                            }}
                                                        >
                                                            <LineRow
                                                                line={l}
                                                                hook="session"
                                                                focused={cursor === l.id}
                                                                fresh={freshSessions.has(keyOf(l))}
                                                                onOpen={
                                                                    l.target != null
                                                                        ? () => openLine(l.target)
                                                                        : undefined
                                                                }
                                                            />
                                                        </motion.div>
                                                    ))}
                                                </AnimatePresence>
                                            </MotionConfig>
                                            {/* runs the lead marked executing and then never touched again: they are
                                            real rows, but a week of silence reads as dead, so they fold */}
                                            {staleCount > 0 && !filtering ? (
                                                <button
                                                    type="button"
                                                    aria-expanded={staleOpen}
                                                    data-jarvis-brief-stale
                                                    onClick={() => setStaleOpen(!staleOpen)}
                                                    className="mt-0.5 cursor-pointer self-start rounded-[6px] border border-border px-2.5 py-1 font-mono text-[10.5px] font-medium text-accent-soft hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                                >
                                                    {staleOpen ? `Hide ${staleCount}` : `+${staleCount}`}{" "}
                                                    {staleCount === 1 ? "run" : "runs"} older than 7 days
                                                </button>
                                            ) : null}
                                            <MoreControl
                                                n={sessions.more}
                                                expanded={sessionsOpen}
                                                onToggle={() => toggleRegion("sessions")}
                                            />
                                        </div>
                                    </Region>
                                ) : null}
                                {view.shows("behind") ? (
                                    <Region
                                        id="behind"
                                        empty={pastRows === 0}
                                        gap="gap-[5px]"
                                        meta={`${pastRows} ${pastRows === 1 ? "event" : "events"}`}
                                        only={only === "behind"}
                                        onOnly={() => toggleOnly("behind")}
                                    >
                                        <div className="flex flex-col pb-1.5">
                                            {lines.behind.length === 0 ? <NoMatch /> : null}
                                            {lines.behind.map((g) => (
                                                <Fragment key={g.label}>
                                                    <span className={SUB_LABEL}>{g.label}</span>
                                                    {g.lines.map((l) => (
                                                        <LineRow
                                                            key={l.id}
                                                            line={l}
                                                            hook={g.label === SHIPPED_LABEL ? "shipped" : "delta"}
                                                            focused={cursor === l.id}
                                                            fresh={false}
                                                            onOpen={
                                                                l.target != null ? () => openLine(l.target) : undefined
                                                            }
                                                        />
                                                    ))}
                                                </Fragment>
                                            ))}
                                            <MoreControl
                                                n={pastMore}
                                                expanded={behindOpen}
                                                onToggle={() => toggleRegion("behind")}
                                            />
                                        </div>
                                    </Region>
                                ) : null}
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                </div>
                {/* the scrim is what makes the reader's overlap read as a layer instead of a clipped row.
                It never takes a click, so the Brief behind it stays live — this is not a modal. */}
                {selectedChunk != null && readingNote != null ? (
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-0 z-[3] hidden bg-background/60 @max-[1280px]:block"
                    />
                ) : null}
                {selectedChunk != null ? (
                    <NoteSidebar
                        label={selectedChunk.row.label}
                        stage={selectedChunk.row.stage}
                        status={selectedChunk.row.status}
                        feed={tracker.feed}
                        reading={readingNote}
                        now={Date.now()}
                        handle={"wsh effort show " + selectedChunk.oref.replace(/^effort:/, "")}
                        error={mutateError}
                        onRead={setReadingNote}
                        onBack={() => setReadingNote(null)}
                        onClose={closeNotes}
                        onActivity={() => openLine({ oref: selectedChunk.oref })}
                        onAddNote={(text) =>
                            runMutation(() => appendChunkNote(selectedChunk.oref, selectedChunk.row.label, text))
                        }
                        onSetStatus={(status) =>
                            runMutation(() => setChunkStatus(selectedChunk.oref, selectedChunk.row.label, status))
                        }
                    />
                ) : null}
            </div>
            <BriefComposer model={model} />
            {/* the Brief's destination for a record address: openref.ts's record landing sets the atom this reads.
                Mounted here rather than beside the surface switch because it is the Brief's own overlay —
                the three-pane composition opens a record on the Stage instead. */}
            <BriefPeek model={model} />
            {/* The same overlay the Stage used to mount, with the Brief's own exits. canOpenRuns is true
                now that a run has a destination: openref.ts's run landing opens the channel's detail sheet, which
                is where the run body and its gate live. A graph-selected record closes into the record
                peek; an Ask closes into the attached Brief thread. */}
            <AnimatePresence>
                {graphOpen ? (
                    <GraphPeek
                        key="brief-graph-peek"
                        model={model}
                        focus={graphFocus}
                        canOpenRuns
                        onOpenRecord={(id) => globalStore.set(briefPeekRecordAtom, id)}
                        onAskAbout={(ref) => openJarvisWithSource(model, ref)}
                        onClose={closeBriefGraph}
                    />
                ) : null}
            </AnimatePresence>
            {/* B4's detail sheet, now drawing the surface's active subject: a channel's run body (or its
                launcher), or an initiative's chunk detail. */}
            <BriefSheet model={model} />
            <BriefProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
            {/* the plan-gate modal, mounted here because the Stage was the surface that hosted it */}
            <DagModal />
        </div>
    );
}
