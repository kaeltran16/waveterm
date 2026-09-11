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
// The record peek is here (BriefPeek, opened by a record oref) and the palette extends the app's own. The
// mockup's remaining row actions — Answer / Look in / open the sheet — still render as stated state rather
// than controls that would navigate nowhere: the session and initiative sheets land with B4 and B5. The
// composer and the thread it grows into are here.
//
// One presentation rule runs through the whole file and decides every border below: a bordered chip is
// the control recipe, a borderless one is a label. Dressing something inert as a control and camouflaging
// a real control among labels are the same lie, so neither happens here.

import { globalStore } from "@/app/store/jotaiStore";
import { buildJarvisBindings } from "@/app/store/keybindings/bindings";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useKeybindings } from "@/app/store/keybindings/store";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { ambientProviderAtom, ensureAmbient } from "@/app/view/agents/ambientstore";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { activeChannelRunsAtom, channelsAtom, loadChannels } from "@/app/view/agents/channelsstore";
import { pendingRunDraftAtom, pendingRunFocusAtom } from "@/app/view/agents/runactions";
import { DagModal } from "@/app/view/orchestrate/dagmodal";
import { setDagModalAgentsContext } from "@/app/view/orchestrate/dagmodalstate";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence } from "motion/react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveComposerLabels, type BriefComposeState } from "./briefcompose";
import { drewOn, type DrewRow } from "./briefdrew";
import { briefFleet } from "./brieffleet";
import { BRIEFING_FIXTURES } from "./briefingfixtures";
import {
    buildAttentionQueue,
    groupDelta,
    mergeActiveWork,
    projectBriefing,
    queueOpenTarget,
    SEVEN_DAYS_MS,
    type ActiveWorkRow,
    type QueueRow,
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
import { briefNavIds, resolveBriefCursor } from "./briefnav";
import { BriefPeek } from "./briefpeekview";
import { BriefProfileModal } from "./briefprofileview";
import { briefRestorePlan } from "./briefrestore";
import { BriefSheet } from "./briefsheet";
import { openJarvisWithSource } from "./contextualentry";
import type { EffortCardModel } from "./effortmodel";
import { peekFocus, type PeekFocus } from "./graphfocus";
import { GraphPeek } from "./graphpeek";
import {
    isAnswerTurn,
    type Freshness,
    type JarvisConversation,
    type JarvisTurn,
    type SourceRef,
    type Terminal,
} from "./jarviscontract";
import {
    briefGraphRecordAtom,
    briefPeekRecordAtom,
    conversationsByIdAtom,
    graphPeekOpenAtom,
    loadJarvisConversations,
    persistedSummariesAtom,
    selectConversation,
} from "./jarvisstore";
import { activeSubjectAtom, persistedSubjectAtom, setActiveRunId } from "./jarvissubjectstore";
import { mentionedDossierIds } from "./mentions";
import { NewChannelControl } from "./newchannelcontrol";
import { openChannelSheet, openORef, openQueueTarget, openRunSheet, orefNavPlan } from "./openref";
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
// is already asking-coloured) which a background swap would overwrite.
const CURSOR_RING = "ring-1 ring-accent/70";

// Every row takes the same two, so the four renderers stay uniform and the scroller can find the cursor.
function cursorAttrs(focused: boolean) {
    return { "data-jarvis-brief-cursor": focused ? "true" : undefined };
}

function RegionHead({ label, meta, count, alert }: { label: string; meta: string; count?: number; alert?: boolean }) {
    return (
        <div className="flex items-center gap-[9px]">
            {alert ? (
                <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-asking motion-reduce:animate-none" />
            ) : null}
            <span className={cn(REGION_LABEL, alert ? "text-asking" : "text-feed-label")}>{label}</span>
            {count != null ? (
                <span className="flex-none rounded-full border border-border px-2 py-px font-mono text-[9.5px] font-semibold text-muted">
                    {count}
                </span>
            ) : null}
            <span className="h-px min-w-3 flex-1 bg-edge-faint" />
            <span className="flex-none font-mono text-[10px] text-ink-faint">{meta}</span>
        </div>
    );
}

function Region({
    id,
    meta,
    count,
    alert,
    empty,
    gap,
    children,
}: {
    id: RegionId;
    meta: string;
    count?: number;
    alert?: boolean;
    empty: boolean;
    gap: string;
    children: ReactNode;
}) {
    const region = REGIONS[id];
    return (
        <section data-jarvis-brief-region={id} className={cn("flex flex-col", gap)}>
            <RegionHead label={region.label} meta={meta} count={count} alert={alert} />
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

// the caps live in the projection; the surface states what they hid instead of growing past them.
function MoreLine({ n }: { n: number }) {
    if (n <= 0) {
        return null;
    }
    return (
        <span className="self-start px-2.5 py-1.5 font-mono text-[10.5px] font-medium text-accent-soft">+{n} more</span>
    );
}

function QueueRowView({ row, focused, onOpen }: { row: QueueRow; focused: boolean; onOpen?: () => void }) {
    const err = row.tone === "error";
    const hasMeta = row.detail !== "" || row.ts != null;
    const base =
        "grid grid-cols-[3px_minmax(0,1fr)] gap-[13px] rounded-[10px] border border-border bg-surface py-[13px] pl-3 pr-[15px]";
    const face = (
        <>
            <span className={cn("self-stretch rounded-[2px]", err ? "bg-error" : "bg-asking")} />
            <div className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-[9px]">
                    <span
                        className={cn(
                            "flex-none font-mono text-[9.5px] font-bold uppercase tracking-[.1em]",
                            err ? "text-error" : "text-asking"
                        )}
                    >
                        {row.kind}
                    </span>
                    <span className="min-w-[220px] flex-1 text-[15px] font-semibold text-ink-hi">{row.title}</span>
                    {row.action != null ? (
                        // The action word names what the row is waiting on; the row opens the run body that
                        // resolves it. So the word stays a label rather than becoming a second control: a
                        // bordered chip beside an already-clickable row is two affordances for one action,
                        // and the one that only names the decision would be the one that looks pressable.
                        <span
                            data-jarvis-brief-action
                            className="flex-none font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
                        >
                            {row.action}
                        </span>
                    ) : null}
                </div>
                {hasMeta ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[10.5px] text-muted">
                        {row.detail !== "" ? <span className="min-w-0 truncate">{row.detail}</span> : null}
                        {row.ts != null ? (
                            <span className="flex-none text-ink-faint">waiting {formatAge(Date.now() - row.ts)}</span>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </>
    );
    // A standalone item names nothing to open, so it stays static info rather than a control that
    // navigates nowhere (the rule this region has always followed for a channel-less row).
    if (onOpen == null) {
        return (
            <div data-jarvis-brief-row="queue" {...cursorAttrs(focused)} className={cn(base, focused && CURSOR_RING)}>
                {face}
            </div>
        );
    }
    return (
        <button
            type="button"
            aria-label={`Open ${row.title}`}
            onClick={onOpen}
            data-jarvis-brief-row="queue"
            {...cursorAttrs(focused)}
            className={cn(
                base,
                "w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                focused && CURSOR_RING
            )}
        >
            {face}
        </button>
    );
}

// A blocked chunk stalls the whole initiative, so it outranks the wire status as the word to print.
// Never the bar alone: the mark and the state word carry what the color says.
function initiativeState(e: EffortCardModel): { word: string; fg: string; bar: string } {
    if (e.blockedChunks.length > 0) {
        return { word: "stalled", fg: "text-asking", bar: "bg-asking" };
    }
    if (e.status === "active") {
        return { word: "active", fg: "text-accent-soft", bar: "bg-accent" };
    }
    return { word: e.status, fg: "text-muted", bar: "bg-edge-strong" };
}

function InitiativeRow({ effort, focused }: { effort: EffortCardModel; focused: boolean }) {
    const state = initiativeState(effort);
    return (
        <div
            data-jarvis-brief-row="initiative"
            {...cursorAttrs(focused)}
            className={cn(
                "flex items-center gap-[11px] rounded-[10px] border border-border bg-surface px-3 py-[11px]",
                focused && CURSOR_RING
            )}
        >
            <span aria-hidden className={cn("flex-none font-mono text-[11px] font-bold", state.fg)}>
                ✦
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-hi">{effort.title}</span>
            <span className="max-w-[240px] flex-none truncate font-mono text-[10px] text-muted">
                {effort.countLine}
            </span>
            <span className="h-[3px] w-[76px] flex-none overflow-hidden rounded-full bg-surface-raised">
                <span
                    className={cn("block h-full rounded-full", state.bar)}
                    style={{ width: `${effort.progressPct}%` }}
                />
            </span>
            <span className={cn("min-w-[118px] flex-none text-right font-mono text-[9.5px] font-semibold", state.fg)}>
                {state.word}
            </span>
        </div>
    );
}

// mergeActiveWork sorts needs-eyes first; the mark repeats that tiering per row so a row's state is a
// glyph and a word, never a color alone. (briefingview keeps the same rule in its local `needsEyes`.)
function sessionMark(row: ActiveWorkRow): { glyph: string; fg: string } {
    if (row.kind === "blocker" || row.chip?.tone === "blocked" || row.chip?.tone === "asking") {
        return { glyph: "!", fg: "text-asking" };
    }
    if (row.chip?.tone === "running") {
        return { glyph: "▶", fg: "text-accent-soft" };
    }
    return { glyph: "·", fg: "text-muted" };
}

// A run row is the one session row with a destination: B4's session sheet. A blocker or a direct agent
// has no sheet yet, so it stays a row rather than becoming a control that opens nothing (the same rule the
// wait queue follows for its channel-less items).
function SessionRow({ row, focused, onOpen }: { row: ActiveWorkRow; focused: boolean; onOpen?: () => void }) {
    const mark = sessionMark(row);
    const openable = row.kind === "run" && onOpen != null;
    const face = (
        <>
            <span aria-hidden className={cn("w-3 flex-none text-center font-mono text-[10px] font-bold", mark.fg)}>
                {mark.glyph}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-hi">{row.name}</span>
            <span className="flex-none rounded-[5px] border border-border px-[7px] py-px font-mono text-[9.5px] text-muted">
                {row.kind}
            </span>
            {row.meta !== "" ? (
                <span className="max-w-[220px] flex-none truncate font-mono text-[10px] text-muted">{row.meta}</span>
            ) : null}
            <span className="flex-none font-mono text-[10px] text-ink-faint">{formatAge(Date.now() - row.ts)}</span>
            <span className={cn("min-w-24 flex-none text-right font-mono text-[9.5px] font-semibold", mark.fg)}>
                {row.chip?.label ?? row.kind}
            </span>
        </>
    );
    const base = "flex items-center gap-3 rounded-[7px] border-b border-edge-faint px-2.5 py-[9px]";
    if (openable) {
        return (
            <button
                type="button"
                aria-label={`Open session sheet for ${row.name}`}
                onClick={onOpen}
                data-jarvis-brief-row="session"
                {...cursorAttrs(focused)}
                className={cn(
                    base,
                    "w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    focused && CURSOR_RING
                )}
            >
                {face}
            </button>
        );
    }
    return (
        <div data-jarvis-brief-row="session" {...cursorAttrs(focused)} className={cn(base, focused && CURSOR_RING)}>
            {face}
        </div>
    );
}

function PastRow({
    hook,
    at,
    verb,
    verbFg,
    what,
    tail,
    focused,
}: {
    hook: string;
    at: string;
    verb: string;
    verbFg: string;
    what: string;
    tail?: ReactNode;
    focused: boolean;
}) {
    return (
        <div
            data-jarvis-brief-row={hook}
            {...cursorAttrs(focused)}
            className={cn("flex min-w-0 items-baseline gap-[13px] rounded-[5px] px-2.5 py-1", focused && CURSOR_RING)}
        >
            <span className="w-[46px] flex-none font-mono text-[10px] text-ink-faint">{at}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-mid">
                <span className={verbFg}>{verb}</span> · {what}
            </span>
            {tail}
        </div>
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
const briefCursorAtom = atom<string | undefined>(undefined);

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

function turnProse(turn: JarvisTurn): string {
    return turn.role === "user" ? turn.text : turn.segments.map((s) => ("text" in s ? s.text : "")).join("");
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

// A citation opens its source, so it is bordered; one with no route is a label, because there is nothing
// to open. `unavailable` and unroutable stay separate reads: a converse thread can report a source stale
// or gone while its oref still routes, and that row must still be clickable.
function SourceChip({
    hook,
    target,
    model,
    children,
}: {
    hook: string;
    target: string;
    model: AgentsViewModel;
    children: ReactNode;
}) {
    const shell =
        "flex max-w-[300px] min-w-0 items-center gap-[7px] rounded-[6px] px-[9px] py-1 font-mono text-[10px] text-muted";
    if (orefNavPlan(target).kind === "unsupported") {
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
            onClick={() => void openORef(model, target)}
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
    return (
        <div data-jarvis-brief-row="turn" className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center gap-[9px]">
                <span className={cn(TURN_WHO, jarvis ? "text-accent-soft" : "text-muted")}>
                    {jarvis ? "Jarvis" : "You"}
                </span>
                <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                    {formatAge(Date.now() - exchange.ts)}
                </span>
            </div>
            <span className="whitespace-pre-wrap text-[13px] leading-[1.6] text-ink-mid">{turnProse(turn)}</span>
            {refs.length > 0 ? (
                // the prose carries the model's own [n] markers, so the per-turn chips are that legend;
                // the Drew band below is the thread's footing, deduped and with the freshness on it.
                <div className="flex min-w-0 flex-wrap gap-[7px]">
                    {refs.map((c) => (
                        <SourceChip key={c.n} hook="cite" target={c.navTarget} model={model}>
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
        <SourceChip hook="drew" target={row.key} model={model}>
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
    // `sheet` is briefcompose's third shape and belongs to the record/session peek sub-project; no state
    // on this surface can produce it, so the Brief resolves launch or thread and nothing else.
    const state: BriefComposeState =
        thread.length === 0 && sourceChip == null
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
    const inFlight = awaitingReply && askState === "pending";
    const canSend = draft.trim() !== "" && !inFlight;

    const submit = () => {
        if (!canSend) {
            return;
        }
        const text = draft.trim();
        setDraft("");
        setThread((t) => [
            ...t,
            { key: `q${t.length}:${Date.now()}`, ts: Date.now(), turn: userTurn(text, scope.attached) },
        ]);
        askAcrossWork(
            text,
            scope.attached.map((ref) => ref.oref)
        );
    };

    // local to the input, never a window listener: the Brief adds no global chord of its own.
    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
                        {thread.map((e) => (
                            <TurnView key={e.key} exchange={e} model={model} />
                        ))}
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
                    {answered ? <DrewBand conversation={conversation} model={model} /> : null}
                </div>
            ) : null}
            <footer
                data-jarvis-brief-band="composer"
                className="flex-none border-t border-edge-faint bg-surface px-[22px] pb-4 pt-2.5"
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

    // The lists the Brief's boot restore validates against. Loaded here rather than inherited: in the Brief
    // composition the Subjects column does not mount, and that column is what loads both of these today.
    useEffect(() => {
        loadTaskList();
        loadJarvisConversations();
        // channels, because a Radar draft names a project and the landing has to resolve it to a channel
        loadChannels();
    }, []);

    // Two landings moved off the Stage with the panes it drew: a "Open run" focus request and a Radar
    // draft. Both are one-shot — `landed` bounds them to a single attempt, because a target that never
    // appears (channel load failed, run gone) must not re-fire on every subject change and yank the user
    // back to it.
    const subject = useAtomValue(activeSubjectAtom);
    const pendingFocus = useAtomValue(pendingRunFocusAtom);
    const setPendingFocus = useSetAtom(pendingRunFocusAtom);
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
    const setPendingDraft = useSetAtom(pendingRunDraftAtom);
    const channels = useAtomValue(channelsAtom);
    const landingRuns = useAtomValue(activeChannelRunsAtom);

    // Radar / graph peek / task correlation asking to show a run: put its channel on the subject, then
    // select the run once that channel's runs have loaded. Landing on the channel is the useful part.
    useEffect(() => {
        if (pendingFocus == null) {
            return;
        }
        if (subject?.kind !== "channel" || subject.id !== pendingFocus.channelId) {
            if (pendingFocus.landed) {
                setPendingFocus(null);
                return;
            }
            void openChannelSheet(pendingFocus.channelId, null);
            setPendingFocus({ ...pendingFocus, landed: true });
            return;
        }
        if (landingRuns.some((r) => r.id === pendingFocus.runId)) {
            setActiveRunId(pendingFocus.channelId, pendingFocus.runId);
            setPendingFocus(null);
        }
    }, [pendingFocus, subject, landingRuns, setPendingFocus]);

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
    const efforts = useMemo(() => model_?.efforts ?? [], [model_]);
    const sessions = useMemo(
        () =>
            model_ != null
                ? mergeActiveWork({
                      activeRuns: model_.activeRuns,
                      blockers: model_.blockers,
                      directAgents: model_.directAgents,
                  })
                : [],
        [model_]
    );
    const deltaGroups = useMemo(() => (model_ != null ? groupDelta(model_.delta, Date.now()) : []), [model_]);
    const shipped = useMemo(() => model_?.shipped ?? [], [model_]);

    // j/k across every region in render order. subjectscolumn.tsx publishes the same controller for this
    // surface in the three-pane composition, but the two compositions never mount together so there is no
    // contest for it. Deliberately no `activate`: nothing on the Brief has a primary action yet, and
    // claiming Enter would swallow it for the composer below — bindings.ts only lets Enter through while
    // the controller leaves it unset.
    const navIds = useMemo(
        () => briefNavIds({ queue, efforts, sessions, deltaGroups, shipped }),
        [queue, efforts, sessions, deltaGroups, shipped]
    );
    const [storedCursor, setCursor] = useAtom(briefCursorAtom);
    const cursor = resolveBriefCursor(navIds, storedCursor);
    useSurfaceListNav(
        useMemo<ListNavController>(
            () => ({ surface: "jarvis", navigableIds: navIds, cursorId: cursor, setCursor }),
            [navIds, cursor, setCursor]
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
    const pastRows = deltaGroups.reduce((n, g) => n + g.rows.length, 0) + shipped.length;
    const pastMore = (model_?.deltaMore ?? 0) + (model_?.shippedMore ?? 0);
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
                {/* the chip needs a snapshot: "all clear" over a load that has not landed is a lie */}
                {model_ != null ? (
                    <span
                        data-jarvis-brief-band="waiting"
                        className={cn(
                            "flex flex-none items-center gap-[7px] rounded-[6px] border px-2.5 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[.06em]",
                            queue.length === 0
                                ? "border-success/30 bg-success/15 text-success"
                                : "border-asking/30 bg-asking/15 text-asking"
                        )}
                    >
                        <span
                            className={cn(
                                "h-[5px] w-[5px] flex-none rounded-full",
                                queue.length === 0 ? "bg-success" : "animate-pulse bg-asking motion-reduce:animate-none"
                            )}
                        />
                        {queue.length === 0 ? "all clear" : `${queue.length} waiting`}
                    </span>
                ) : null}
                <span data-jarvis-brief-band="fleet" className="flex-none font-mono text-[10px] text-muted">
                    {fleet.line}
                </span>
                {/* A real control with the control recipe's border: invariant 4 forbids camouflaging it among
                    the status chips above, which are borderless labels. */}
                <button
                    type="button"
                    onClick={() => setProfileOpen(true)}
                    className="flex-none cursor-pointer rounded-[6px] border border-border px-2.5 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[.06em] text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    Profile
                </button>
                <NewChannelControl model={model} />
            </header>
            {staleSnapshot ? (
                <div
                    data-jarvis-brief-band="stale"
                    className="flex flex-none items-center gap-2 border-b border-edge-faint px-[22px] py-1 font-mono text-[10px] text-error"
                >
                    <span aria-hidden className="font-bold">
                        ✕
                    </span>
                    refresh failed — showing the previous snapshot
                </div>
            ) : null}
            <div
                className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-[22px] pb-2.5 pt-5"
                aria-live="polite"
            >
                {loadFailed ? (
                    <div
                        data-jarvis-brief-state="error"
                        className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-4 py-3"
                    >
                        <span className="text-[13px] font-semibold text-ink-hi">Couldn't load your work state.</span>
                        <span className="text-[12px] text-secondary">{error}</span>
                        <button
                            type="button"
                            onClick={refreshBriefing}
                            className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            Retry
                        </button>
                    </div>
                ) : null}
                {firstLoad ? (
                    <div data-jarvis-brief-state="loading" className="flex flex-col gap-[26px]">
                        {Object.entries(REGIONS).map(([id, r]) => (
                            <div key={id} className="flex flex-col gap-2">
                                <span className={cn(REGION_LABEL, "text-feed-label")}>{r.label}</span>
                                <div className="h-12 animate-pulse rounded-[10px] bg-surface motion-reduce:animate-none" />
                            </div>
                        ))}
                    </div>
                ) : null}
                {model_ != null ? (
                    <>
                        <Region
                            id="waiting"
                            alert={queue.length > 0}
                            empty={queue.length === 0}
                            gap="gap-[9px]"
                            meta="oldest first · gates before asks"
                        >
                            <div className="flex flex-col gap-[9px]">
                                {queue.map((q) => {
                                    const target = queueOpenTarget(q.nav);
                                    return (
                                        <QueueRowView
                                            key={q.key}
                                            row={q}
                                            focused={cursor === `waiting:${q.key}`}
                                            onOpen={target == null ? undefined : () => openQueueTarget(model, target)}
                                        />
                                    );
                                })}
                            </div>
                        </Region>
                        <Region
                            id="initiatives"
                            count={efforts.length}
                            empty={efforts.length === 0}
                            gap="gap-2.5"
                            meta={stalled > 0 ? `${stalled} stalled` : "all moving"}
                        >
                            <div className="flex flex-col gap-2.5">
                                {efforts.map((e) => (
                                    <InitiativeRow
                                        key={e.oref}
                                        effort={e}
                                        focused={cursor === `initiatives:${e.oref}`}
                                    />
                                ))}
                                <MoreLine n={model_.effortMore} />
                            </div>
                        </Region>
                        <Region id="sessions" empty={sessions.length === 0} gap="gap-1" meta="run on their own">
                            <div className="flex flex-col gap-1">
                                {sessions.map((r) => (
                                    <SessionRow
                                        key={r.key}
                                        row={r}
                                        focused={cursor === `sessions:${r.key}`}
                                        onOpen={
                                            r.kind === "run"
                                                ? () => fireAndForget(() => openRunSheet(r.oref.replace(/^run:/, "")))
                                                : undefined
                                        }
                                    />
                                ))}
                                <MoreLine n={model_.activeMore} />
                            </div>
                        </Region>
                        <Region
                            id="behind"
                            empty={pastRows === 0}
                            gap="gap-[5px]"
                            meta={`${pastRows} ${pastRows === 1 ? "event" : "events"}`}
                        >
                            <div className="flex flex-col gap-[5px] pb-1.5">
                                {deltaGroups.map((g) => (
                                    <Fragment key={g.label}>
                                        <span className={SUB_LABEL}>{g.label}</span>
                                        {g.rows.map((d) => (
                                            <PastRow
                                                key={d.key}
                                                hook="delta"
                                                at={formatAge(Date.now() - d.ts)}
                                                verb={d.wording}
                                                verbFg="text-muted"
                                                what={d.title}
                                                focused={cursor === `behind:${d.key}`}
                                            />
                                        ))}
                                    </Fragment>
                                ))}
                                {shipped.length > 0 ? (
                                    <>
                                        <span className={SUB_LABEL}>Shipped · 7 days</span>
                                        {shipped.map((s) => (
                                            <PastRow
                                                key={s.oref}
                                                hook="shipped"
                                                at={formatAge(Date.now() - s.completedTs)}
                                                verb="Shipped"
                                                verbFg="text-success"
                                                what={[s.goal, s.project].filter((p) => p !== "").join(" · ")}
                                                focused={cursor === `behind:shipped:${s.oref}`}
                                                tail={
                                                    s.fresh ? (
                                                        <span className="flex-none rounded-[4px] bg-success/15 px-1.5 py-px font-mono text-[9.5px] font-semibold uppercase text-success">
                                                            New
                                                        </span>
                                                    ) : null
                                                }
                                            />
                                        ))}
                                    </>
                                ) : null}
                                <MoreLine n={pastMore} />
                            </div>
                        </Region>
                    </>
                ) : null}
            </div>
            <BriefComposer model={model} />
            {/* the Brief's destination for a record oref: openref.ts's task arm sets the atom this reads.
                Mounted here rather than beside the surface switch because it is the Brief's own overlay —
                the three-pane composition opens a record on the Stage instead. */}
            <BriefPeek model={model} />
            {/* The same overlay the Stage used to mount, with the Brief's own exits. canOpenRuns is true
                now that a run has a destination: openORef's run arm opens the channel's detail sheet, which
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
