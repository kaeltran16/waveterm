// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-only briefing fixtures: five load states a human and the CDP verify:ui harness can render
// without a backend. The `load` states are real WorkState shapes — the projection and the view must not
// special-case them — and the timestamps hang off a fixed `now` so the shots are deterministic. Compiled
// out of production builds (only reachable through the briefingFixtureAtom seam, which import.meta.env.DEV
// gates).
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { missingLegs, SHIPPED_CAP } from "./briefingmodel";
import type { BriefingLoadState } from "./briefingstore";

export type BriefingFixtureName =
    | "normal"
    | "attention"
    | "empty"
    | "partial"
    | "failed"
    | "act"
    | "review"
    | "initiatives";
export interface BriefingFixture {
    load: BriefingLoadState;
    agents: AgentVM[];
    // the waiting-on-you queue reads the live attention poll, not the snapshot, so a fixture has to
    // seed it separately or the queue is invisible in every fixture state.
    attention: AttentionItem[];
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// effort leg fixtures: shared by the briefing projection tests and the dev/CDP fixture states
// (non-UUID oids are fine here — these never flow through ParseORef server-side)
export const EFFORT_FIXTURES: EffortSummary[] = [
    {
        oref: "effort:scenario-gate",
        title: "Scenario gate clearance",
        status: "active",
        done: 2,
        total: 8,
        activechunk: "Phase 3",
        updatedts: NOW - DAY,
        chunks: [
            { label: "Phase 1", status: "done" },
            { label: "Phase 2", status: "done" },
            { label: "Phase 3", status: "active" },
            { label: "Phase 4", status: "deferred" },
            { label: "Phase 5", status: "blocked" },
            { label: "Phase 6", status: "skipped" },
            { label: "Phase 7", status: "pending" },
            { label: "Phase 8", status: "pending" },
        ],
    },
    {
        oref: "effort:reflux",
        title: "Reflux state-layer migration",
        status: "active",
        done: 0,
        total: 14,
        activechunk: "jotai store extraction",
        updatedts: NOW - 2 * DAY,
        chunks: Array.from({ length: 14 }, (_, i) => ({
            label: `slice ${i + 1}`,
            status: i === 0 ? "active" : "pending",
        })),
    },
];

const agents: AgentVM[] = [
    {
        id: "tab-direct",
        name: "loom",
        task: "polish the composer",
        state: "working",
        agent: "claude",
        project: "waveterm",
        activeMs: 4 * 60_000,
    },
];

const normalState: WorkState = {
    projects: [
        {
            project: "waveterm",
            active: [
                {
                    project: "waveterm",
                    kind: "run",
                    title: "Ship the landing briefing",
                    detail: "status: executing",
                    ts: NOW - 2 * DAY,
                    navtarget: "run:r-briefing-1",
                    workerorefs: ["tab:tab-run"],
                },
                {
                    project: "waveterm",
                    kind: "run",
                    title: "Port the usage charts",
                    detail: "status: blocked",
                    ts: NOW - 3 * DAY,
                    navtarget: "run:r-briefing-2",
                },
                {
                    project: "",
                    kind: "blocker",
                    title: "Unify the vault scope model",
                    detail: "needs decision on collection scoping",
                    ts: NOW - DAY,
                    navtarget: "task:d-briefing-1",
                },
            ],
            shipped: [
                {
                    project: "waveterm",
                    runoid: "r-briefing-shipped",
                    goal: "Memory recentralization",
                    summary: "vault is the single source of truth",
                    completedts: NOW - DAY,
                },
            ],
            events: [],
            delta: [
                {
                    ts: NOW - 2 * DAY,
                    kind: "run-created",
                    project: "waveterm",
                    title: "Ship the landing briefing",
                    detail: "status: executing",
                    navtarget: "run:r-briefing-1",
                },
                {
                    ts: NOW - DAY,
                    kind: "run-done",
                    project: "waveterm",
                    title: "Memory recentralization",
                    detail: "vault is the single source of truth",
                    navtarget: "run:r-briefing-shipped",
                },
                { ts: NOW - 3 * DAY, kind: "decision", title: "chose sqlite over a second store" },
            ],
        },
    ],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
    efforts: EFFORT_FIXTURES,
};

const attentionState: WorkState = {
    projects: [
        {
            project: "waveterm",
            active: [
                ...(normalState.projects[0].active ?? []),
                {
                    project: "waveterm",
                    kind: "attention",
                    title: "the ask bridge",
                    detail: "Review: check the diff",
                    ts: NOW - DAY,
                    navtarget: "run:r-briefing-1",
                },
            ],
            shipped: normalState.projects[0].shipped,
            events: [],
            delta: [
                ...(normalState.projects[0].delta ?? []),
                {
                    ts: NOW - DAY,
                    kind: "attention",
                    title: "the ask bridge",
                    detail: "Review: check the diff",
                    navtarget: "run:r-briefing-1",
                },
            ],
        },
    ],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
    efforts: EFFORT_FIXTURES,
};

// the runs and efforts legs failed: the server degrades each to empty and says so in sources
const partialState: WorkState = {
    projects: normalState.projects.map((p) => ({
        ...p,
        active: (p.active ?? []).filter((a) => a.kind !== "run"),
        shipped: [],
    })),
    sources: { runs: false, sessions: true, dossiers: true, efforts: false, attention: "volatile" },
};

const emptyState: WorkState = {
    projects: [],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
};

const loaded = (state: WorkState): BriefingLoadState => ({
    snapshot: {
        state,
        queryStartedAt: NOW,
        actualCursor: NOW - 7 * DAY,
        complete: missingLegs(state.sources).length === 0,
    },
    loading: false,
    error: null,
});

// one of each shape the queue can take: a held land with a run to land on, an escalation, and a
// dag-blocked row carrying the error tone. The attribution, why-line and citations are written the way
// pkg/jarvis/attention.go composes them for these shapes — a fixture whose why-line no server would
// emit would verify a row the app cannot actually produce.
const attentionItems: AttentionItem[] = [
    {
        kind: "run-land-held",
        key: "run-land-held:r-briefing-1",
        channelid: "ch-briefing",
        channelname: "waveterm",
        runid: "r-briefing-1",
        source: "the ask bridge",
        text: "The run's branch was not merged back: the merge conflicts with main in pkg/agentask/encode.go",
        reason: "the merge conflicts with main in pkg/agentask/encode.go",
        action: "Review",
        phaseidx: 0,
        waitingsince: NOW - DAY,
        effortoid: "scenario-gate",
        chunklabel: "Phase 3",
        why: "The work is on wave/r-briefing-1. Clear the reason, then run `wsh runs land r-briefing-1`.",
    },
    {
        kind: "escalation",
        key: "esc:m-1",
        channelid: "ch-briefing",
        channelname: "waveterm",
        runid: "r-briefing-1",
        source: "frontend-e2e",
        text: "Confirm the CDP port override before I keep going.",
        action: "Decide",
        phaseidx: 0,
        waitingsince: NOW - 2 * 60 * 1000,
        effortoid: "scenario-gate",
        chunklabel: "Phase 3",
        why: "Jarvis escalated this instead of answering it; frontend-e2e is paused until it is decided.",
    },
    {
        kind: "dag-blocked",
        key: "dag-blocked:g-1",
        channelid: "ch-briefing",
        channelname: "waveterm",
        runid: "r-briefing-2",
        source: "usage charts",
        text: "3 consecutive failures — decide retry/skip.",
        action: "Review",
        phaseidx: 0,
        waitingsince: NOW - DAY,
        why: "5 of 9 tasks done. The group stays stopped until you retry or skip.",
    },
];

// "act": the shapes the Brief has to help you act on. Blockers of different ages with what each needs (one
// whose newer note says it cleared), quiet initiatives behind the fold, blocked runs a month old, a run
// attached to an initiative, a multi-paragraph goal, a report-markdown summary on a cwd path, and rows past
// every region's cap for the filter to reach.
const HOUR = 60 * 60 * 1000;
const actEffort = (
    oid: string,
    title: string,
    idle: number,
    chunks: EffortChunkSummary[],
    project = "waveterm"
): EffortSummary => ({
    oref: "effort:" + oid,
    title,
    project,
    status: "active",
    done: chunks.filter((c) => c.status === "done").length,
    total: chunks.length,
    updatedts: NOW - idle,
    chunks,
});
const ACT_EFFORTS: EffortSummary[] = [
    actEffort("act-rules", "Anomaly-to-rule pipeline", 3 * HOUR, [
        { label: "G9 draft the rule", status: "done" },
        {
            label: "G10 validate the G4 label",
            status: "blocked",
            blocked: { since: NOW - 22 * DAY, needs: "needs: the G4 label from the data team" },
        },
        {
            label: "S6 per-tenant soak",
            status: "blocked",
            blocked: {
                since: NOW - 14 * DAY,
                needs: "needs: a clean DEV soak",
                latest: { ts: NOW - 3 * DAY, text: "the empty-buffer blocker is gone on DEV" },
            },
        },
    ]),
    actEffort("act-cutover", "Pipeline cutover", 2 * DAY, [
        {
            label: "P2 cut traffic over",
            status: "blocked",
            blocked: { since: NOW - 2 * DAY, needs: "needs: an SRE window" },
        },
    ]),
    ...Array.from({ length: 4 }, (_, i) =>
        actEffort(`act-busy-${i}`, `Busy initiative ${i + 1}`, (i + 1) * HOUR, [{ label: "next", status: "active" }])
    ),
    actEffort("act-quiet-1", "Concurrent runs contract", 12 * DAY, [{ label: "C1", status: "pending" }]),
    actEffort("act-quiet-2", "Fold-hidden hypothesis tracker", 19 * DAY, [{ label: "H1", status: "pending" }]),
];
const ACT_GOAL =
    "Clean up the cockpit's run list so a cancelled run reads plainly.\n\nRead the run store first, then the view; keep the change small.";
const actState: WorkState = {
    projects: [
        {
            project: "C:\\Users\\dev\\IdeaProjects\\waveterm",
            active: Array.from({ length: 3 }, (_, i) => ({
                project: "C:\\Users\\dev\\IdeaProjects\\waveterm",
                kind: "run",
                title: `e2e quick run ${i + 1}`,
                detail: "status: blocked",
                ts: NOW - 27 * DAY,
                navtarget: `run:r-act-stale-${i}`,
                mode: "quick",
            })),
            shipped: [
                {
                    project: "C:\\Users\\dev\\IdeaProjects\\portfolio-redesign",
                    runoid: "r-act-shipped",
                    // past a tooltip's length, so the row's title must come from the report's H1 (brief-act 41)
                    goal: "Redesign the portfolio's hero so a visitor reads who it is for in one glance. Rebuild the layout in the hero component, keep the copy to two lines, check it at phone and desktop widths, and leave the rest of the page as it is.",
                    summary: "# Run report: Portfolio hero\n\n## Tasks\n- t-1: **rebuilt** the hero in `hero.tsx`",
                    completedts: NOW - 5 * HOUR,
                    hasreport: true,
                    mode: "orchestrator",
                },
            ],
            events: [],
            delta: [
                {
                    ts: NOW - HOUR,
                    kind: "run-created",
                    project: "C:\\Users\\dev\\IdeaProjects\\waveterm",
                    title: "Unblock the G10 label check",
                    detail: "status: executing",
                    navtarget: "run:r-act-attached",
                    effortoid: "act-rules",
                },
                {
                    ts: NOW - 2 * HOUR,
                    kind: "effort-note",
                    project: "waveterm",
                    title: "Anomaly-to-rule pipeline",
                    detail: "G9 draft the rule · Drafted the rule. Next is the label.",
                    navtarget: "effort:act-rules",
                },
                {
                    ts: NOW - 3 * HOUR,
                    kind: "run-created",
                    project: "C:\\Users\\dev\\IdeaProjects\\waveterm",
                    title: ACT_GOAL,
                    detail: "status: cancelled",
                    navtarget: "run:r-act-cancelled",
                },
                ...Array.from({ length: 5 }, (_, i) => ({
                    ts: NOW - (2 + i) * DAY,
                    kind: "decision",
                    title: `filler decision ${i + 1}`,
                })),
                { ts: NOW - 6 * DAY - HOUR, kind: "decision", title: "dag-motion easing settled" },
            ],
        },
    ],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
    efforts: ACT_EFFORTS,
};

// "review": the 11-05 code review's Waiting and Behind you findings (brief-act steps 12 on). A run-unverified
// pair and a held land read by their own kind words; the held land offers Retry land and Dismiss; an ask
// with no channel offers nothing. Behind you: six decisions in the "" project, which the server lists first,
// all older than a run and an initiative from today, and that initiative's 40 notes, which fold to one row.
const MIN = 60_000;
const REVIEW_PROJECT = "C:\\Users\\dev\\IdeaProjects\\waveterm";
const REVIEW_EFFORT = "review-notes";
const reviewRun = (kind: string, runid: string, source: string, text: string, reason?: string): AttentionItem => ({
    kind,
    key: `${kind}:${runid}`,
    channelid: "ch-review",
    channelname: "waveterm",
    runid,
    source,
    text,
    reason,
    action: "Review",
    phaseidx: 0,
    waitingsince: NOW - 2 * HOUR,
});
const REVIEW_ASKER: AgentVM = {
    id: "tab-review-asker",
    name: "review asker",
    task: "pick the first tenant",
    state: "asking",
    agent: "claude",
    project: "waveterm",
    blockedMs: 5 * MIN,
};
// a direct agent's ask: no channel, its tab in the oref, and the server's fallback word as the source (F2)
const REVIEW_AGENT_ASK_TEXT = "Can I rename the tenant table?";
const reviewAgentAsk: AttentionItem = {
    kind: "ask",
    key: "ask:review-agent",
    source: "agent",
    text: REVIEW_AGENT_ASK_TEXT,
    action: "Answer",
    phaseidx: 0,
    waitingsince: NOW - 30 * MIN,
    oref: "tab:" + REVIEW_ASKER.id,
};
const reviewAttention: AttentionItem[] = [
    reviewRun("run-unverified", "r-review-u1", "review unverified one", "The run landed but its Verify never ran."),
    reviewRun("run-unverified", "r-review-u2", "review unverified two", "The run landed but its Verify never ran."),
    reviewRun(
        "run-land-held",
        "r-review-held",
        "review held land",
        "The run's branch was not merged back: the merge conflicts with main in pkg/x.go",
        "the merge conflicts with main in pkg/x.go"
    ),
    {
        kind: "ask",
        key: "ask:review-standalone",
        source: "review standalone ask",
        text: "Which tenant goes first?",
        action: "Answer",
        phaseidx: 0,
        waitingsince: NOW - HOUR,
    },
    reviewAgentAsk,
];
// Runs: twelve orchestrator runs a week quiet beside two live quick runs, so the kind chips and the head's
// "N live" can disagree (F15), and an asking direct agent whose Answer goes to the agent (F6)
const reviewRuns = (n: number, tag: string, mode: string, age: number): ActiveWorkItem[] =>
    Array.from({ length: n }, (_, i) => ({
        project: REVIEW_PROJECT,
        kind: "run",
        title: `Review ${tag} ${mode} run ${i + 1}`,
        detail: "status: executing",
        ts: NOW - age - i * MIN,
        navtarget: `run:r-review-${tag}-${i + 1}`,
        mode,
    }));
// the work-state keys the server writes beside a project's path: the same project by name, a run worktree and
// "(none)" (F1). None holds work, so the regions read as before.
const noWork = (project: string) => ({ project, active: [], shipped: [], events: [], delta: [] });
const reviewState: WorkState = {
    projects: [
        {
            project: "",
            active: [],
            shipped: [],
            events: [],
            delta: Array.from({ length: 6 }, (_, i) => ({
                ts: NOW - (20 + i) * MIN,
                kind: "decision",
                title: `review decision ${i + 1}`,
            })),
        },
        {
            project: REVIEW_PROJECT,
            active: [...reviewRuns(12, "stale", "orchestrator", 10 * DAY), ...reviewRuns(2, "live", "quick", 20 * MIN)],
            shipped: [
                {
                    project: REVIEW_PROJECT,
                    runoid: "r-review-shipped",
                    goal: "Review shipped run",
                    summary: "shipped for the review fixture",
                    completedts: NOW - 3 * HOUR,
                    mode: "quick",
                },
                // past Shipped's cap, for the run sheet to step into its fold (F16)
                ...Array.from({ length: SHIPPED_CAP + 1 }, (_, i) => ({
                    project: REVIEW_PROJECT,
                    runoid: `r-review-shipped-${i + 1}`,
                    goal: `Review shipped run ${i + 1}`,
                    summary: "shipped for the review fixture",
                    completedts: NOW - (4 + i) * HOUR,
                    mode: "quick",
                })),
            ],
            events: [],
            delta: [
                {
                    ts: NOW - 10 * MIN,
                    kind: "run-created",
                    project: REVIEW_PROJECT,
                    title: "Review run from today",
                    detail: "status: executing",
                    navtarget: "run:r-review-today",
                },
                ...Array.from({ length: 40 }, (_, i) => ({
                    ts: NOW - 2 * MIN - i * 5000,
                    kind: "effort-note",
                    project: "waveterm",
                    title: "Review notes initiative",
                    detail: `N1 the note chunk · note ${40 - i} on the chunk.`,
                    navtarget: "effort:" + REVIEW_EFFORT,
                })),
            ],
        },
        noWork("waveterm"),
        noWork("C:\\Users\\dev\\AppData\\Local\\arc-wt\\5638249e-t-1"),
        noWork("(none)"),
    ],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
    efforts: [
        actEffort(REVIEW_EFFORT, "Review notes initiative", 2 * MIN, [
            { label: "N1 the note chunk", status: "active" },
        ]),
    ],
};

// "initiatives": ten initiatives over two projects in activity order A to J, H and I holding blocked chunks, so
// Initiatives' window has to reach past its cap for them (F8); with the review queue and three shipped runs, a
// filter has counts to narrow in Waiting, Initiatives and Shipped (F16).
const WINDOW_INITIATIVES = "ABCDEFGHIJ".split("").map((c) => `Window initiative ${c}`);
const initiativesState: WorkState = {
    projects: [
        {
            project: REVIEW_PROJECT,
            active: [],
            shipped: Array.from({ length: 3 }, (_, i) => ({
                project: REVIEW_PROJECT,
                runoid: `r-window-shipped-${i + 1}`,
                goal: `Window shipped run ${i + 1}`,
                summary: "shipped for the initiatives fixture",
                completedts: NOW - (i + 1) * HOUR,
                mode: i === 0 ? "orchestrator" : "quick",
            })),
            events: [],
            delta: [],
        },
    ],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
    efforts: WINDOW_INITIATIVES.map((title, i) =>
        actEffort(
            `window-${i + 1}`,
            title,
            (i + 1) * HOUR,
            i === 7 || i === 8
                ? [{ label: "W blocked", status: "blocked", blocked: { since: NOW - DAY, needs: "needs: a review" } }]
                : [{ label: "W next", status: "active" }],
            i % 2 === 0 ? "waveterm" : "portfolio"
        )
    ),
};

export const BRIEFING_FIXTURES: Record<BriefingFixtureName, BriefingFixture> = {
    normal: { load: loaded(normalState), agents, attention: [] },
    attention: { load: loaded(attentionState), agents, attention: attentionItems },
    empty: { load: loaded(emptyState), agents, attention: [] },
    partial: { load: loaded(partialState), agents, attention: [] },
    failed: { load: { snapshot: null, loading: false, error: "fixture failure" }, agents: [], attention: [] },
    act: { load: loaded(actState), agents: [], attention: [] },
    review: { load: loaded(reviewState), agents: [REVIEW_ASKER], attention: reviewAttention },
    initiatives: { load: loaded(initiativesState), agents: [], attention: reviewAttention },
};
