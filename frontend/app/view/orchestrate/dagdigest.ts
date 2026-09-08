// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The orchestrator status digest hook: loads DagStatusCommand's {Group, Digest} and accepts a response
// only when it is fresh (Digest.DagVersion == observed TaskGroup.Version) and belongs to the newest
// outstanding request (spec 9). A stale/failed digest never replaces task facts — the caller renders
// them behind "Refreshing status".

import { useCallback, useEffect, useRef, useState } from "react";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useRunEvents } from "../agents/runeventstore";
import { useDagGroup } from "./dagstore";

export type DigestState = {
    digest?: DagStatusDigest;
    loading: boolean;
    // derived, never stored: see digestStale
    stale: boolean;
    error?: string;
    // when the held digest was last confirmed current; absent until one has been accepted
    lastUpdatedTs?: number;
    retry?: () => void;
};

// TaskBrief is the little the next-step line needs to name a task: its label, and enough state to say
// whether it is still executing or already finished and waiting to be integrated.
export type TaskBrief = { label: string; state: string };

export function taskBriefs(group: TaskGroup | undefined): Map<string, TaskBrief> {
    const briefs = new Map<string, TaskBrief>();
    for (const t of group?.tasks ?? []) {
        briefs.set(t.id, { label: t.label || t.id, state: t.state });
    }
    return briefs;
}

// events whose arrival means the current digest may be out of date (ask/answer/clear and control
// delivery). Not activity ticks — those never re-request the digest.
const REFRESH_EVENT_KINDS = new Set([
    "child-ask",
    "child-answered",
    "child-ask-cleared",
    "lead-control-sent",
    "lead-control-failed",
    "lead-control-acknowledged",
]);

// acceptDigest decides whether candidate may replace the current digest: its DagVersion must equal the
// observed group version, and it must be the response to the newest outstanding request (an older
// same-version response loses to a newer request, spec 10.2 ask-changes-during-load race).
export function acceptDigest(
    candidate: DagStatusDigest,
    observedVersion: number,
    requestToken: number,
    newestToken: number
): boolean {
    return candidate.dagversion === observedVersion && requestToken === newestToken;
}

// shouldRefreshDigest reports whether a runevent kind schedules another digest load. Only the
// digest-relevant kinds count; a plain activity tick must not re-request.
export function shouldRefreshDigest(eventKind: string | undefined): boolean {
    return eventKind != null && REFRESH_EVENT_KINDS.has(eventKind);
}

// MAX_NAMED_TASKS caps how many tasks one next-step line names before summarising. A line that grows
// with the dag stops being readable at exactly the width where it matters.
const MAX_NAMED_TASKS = 2;

function labelOf(id: string, briefs?: Map<string, TaskBrief>): string {
    return briefs?.get(id)?.label || id;
}

function nameList(ids: string[] | undefined, briefs: Map<string, TaskBrief> | undefined, name = labelOf): string {
    if (ids == null || ids.length === 0) {
        return "";
    }
    const shown = ids.slice(0, MAX_NAMED_TASKS).map((id) => name(id, briefs));
    const rest = ids.length - shown.length;
    return shown.join(", ") + (rest > 0 ? ` +${rest} more` : "");
}

// blockerName says what a blocking task is actually waiting for. A dependency that is already done yet
// still blocks its successor is waiting to be integrated, not to finish — the distinction the reader
// needs to know whether anything is running at all.
function blockerName(id: string, briefs?: Map<string, TaskBrief>): string {
    const label = labelOf(id, briefs);
    return briefs?.get(id)?.state === "done" ? `${label}'s merge` : label;
}

// nextStepText renders the typed next-step kind as a short imperative line for the overview header,
// naming the tasks the digest already identifies ("ship it waiting on scaffold API's merge"). Falls
// back to the generic phrasing when the step carries no ids, and to the raw id when no label is known:
// presentation only, and never a task name this UI invented. The digest contract stays typed and is
// never re-derived here.
export function nextStepText(next: DagNextStep, briefs?: Map<string, TaskBrief>): string {
    const named = nameList(next.taskids, briefs);
    switch (next.kind) {
        case "human-action": {
            const actions = next.actions?.join(" / ") ?? "action";
            return `waiting on you — ${actions}` + (named ? `: ${named}` : "");
        }
        case "merge-ready":
            return "merge ready for review" + (named ? `: ${named}` : "");
        case "dispatch":
            return named ? `dispatching ${named}` : "dispatching next task";
        case "parallelism-wait": {
            const busy = nameList(next.blockingtaskids, briefs);
            return busy ? `waiting for a slot — ${busy} still running` : "waiting on parallelism limit";
        }
        case "dependency-wait": {
            const blockers = nameList(next.blockingtaskids, briefs, blockerName);
            return named && blockers ? `${named} waiting on ${blockers}` : "waiting on dependencies";
        }
        case "cleanup-wait":
            return "waiting on worktree cleanup" + (named ? `: ${named}` : "");
        case "terminal":
            return `finished (${next.terminalstatus ?? "done"})`;
        default:
            return "refreshing status";
    }
}

// --- degradation views (spec 8): what the overview may claim, given the digest's state ---------

// HEALTH_TONE maps the digest's health enum onto tone tokens. Absent from the map means the digest
// said something this UI does not understand — which is never a reason to paint it healthy.
const HEALTH_TONE: Record<string, string> = {
    "needs-you": "text-warning",
    stalled: "text-error",
    healthy: "text-success",
    done: "text-muted",
    cancelled: "text-muted",
};

// digestStale reports whether the held digest describes a DAG version that has already moved on. It is
// a fact about the two versions, so the caller derives it every render rather than storing a flag: a
// stored flag can only flip when a request *returns*, which left the previous version's health and
// counts reading as current for the whole reload.
export function digestStale(digest: DagStatusDigest | undefined, observedVersion: number | undefined): boolean {
    return digest != null && digest.dagversion !== observedVersion;
}

// healthView is the single decision about what the health strip says. Three rules it must never break:
// an unavailable digest is never rendered as healthy, a stale digest's health is not shown as if it
// were current, and a refresh that failed is not dressed up as one still in flight — the reader can
// wait out the second, but only the first is theirs to retry.
export function healthView(state: DigestState): { text: string; tone: string } {
    if (state.digest == null) {
        return { text: state.loading ? "Loading status…" : "DAG status unavailable", tone: "text-muted" };
    }
    if (state.stale) {
        return state.error != null && !state.loading
            ? { text: "Status update failed", tone: "text-warning" }
            : { text: "Refreshing status", tone: "text-muted" };
    }
    return { text: state.digest.health, tone: HEALTH_TONE[state.digest.health] ?? "text-muted" };
}

// lastUpdatedText says when the shown status was last confirmed current, so a reader can tell a quiet
// DAG from one whose status stopped arriving. Null until a digest has actually been accepted.
export function lastUpdatedText(state: DigestState, nowMs: number): string | null {
    if (state.lastUpdatedTs == null || state.lastUpdatedTs <= 0) {
        return null;
    }
    const secs = Math.max(0, Math.floor((nowMs - state.lastUpdatedTs) / 1000));
    if (secs < 60) {
        return `updated ${secs}s ago`;
    }
    const mins = Math.floor(secs / 60);
    return mins < 60 ? `updated ${mins}m ago` : `updated ${Math.floor(mins / 60)}h ago`;
}

// nextStepView returns the next-engine-move line, or null when there is no claim the UI is entitled
// to make. A stale digest's "next" is a statement about a DAG version that has already moved on.
export function nextStepView(state: DigestState, briefs?: Map<string, TaskBrief>): string | null {
    if (state.digest == null || state.stale) {
        return null;
    }
    return nextStepText(state.digest.next, briefs);
}

// freshCounts returns the counts only while they are current, for the same reason.
export function freshCounts(state: DigestState): DagStatusCounts | undefined {
    return state.digest == null || state.stale ? undefined : state.digest.counts;
}

// CONTROL_WARNING is the human-facing half of the control digest. Acknowledged (and no attempt at
// all) say nothing: control delivery is visibility, and a warning for the normal case is noise.
const CONTROL_WARNING: Record<string, string> = {
    unconfirmed: "lead not confirmed",
    failed: "lead notify failed",
    unavailable: "lead unreachable",
};

export function controlWarning(digest: DagStatusDigest | undefined): string | null {
    return digest?.control ? (CONTROL_WARNING[digest.control.status] ?? null) : null;
}

// useDagDigest loads the status digest for an orchestrator run and keeps it fresh: initially, on any
// observed TaskGroup.Version change (via the live WOS group), on digest-relevant run events, and on an
// explicit retry. A running request token guards out-of-order responses. Errors keep the last good
// digest and surface the failure, so the caller can say "out of date" instead of inventing health.
export function useDagDigest(channelId: string, runId: string, dagOref: string): DigestState {
    const [group] = useDagGroup(dagOref);
    const observedVersion = group?.version;
    const events = useRunEvents(runId, channelId);
    const [state, setState] = useState<Omit<DigestState, "stale" | "retry">>({ loading: true });
    const requestTokenRef = useRef(0);
    const newestTokenRef = useRef(0);
    const seenEventsRef = useRef(new Set<string>());
    // unseen digest-relevant events and explicit retries bump this nonce and re-trigger the load effect
    const [refreshNonce, setRefreshNonce] = useState(0);
    const nextNonce = useRef(0);

    const retry = useCallback(() => {
        nextNonce.current++;
        setRefreshNonce(nextNonce.current);
    }, []);

    // mark newly seen digest-relevant events once; each bump triggers the load effect below
    useEffect(() => {
        let bumped = false;
        for (const ev of events) {
            if (shouldRefreshDigest(ev.kind) && !seenEventsRef.current.has(ev.id)) {
                seenEventsRef.current.add(ev.id);
                nextNonce.current++;
                bumped = true;
            }
        }
        if (bumped) {
            setRefreshNonce(nextNonce.current);
        }
    }, [events]);

    useEffect(() => {
        if (observedVersion == null) {
            return;
        }
        let cancelled = false;
        const token = ++requestTokenRef.current;
        newestTokenRef.current = token;
        setState((s) => ({ ...s, loading: true }));
        RpcApi.DagStatusCommand(TabRpcClient, { channelid: channelId, runid: runId })
            .then((rtn) => {
                if (cancelled) {
                    return;
                }
                if (!acceptDigest(rtn.digest, observedVersion, token, newestTokenRef.current)) {
                    // the held digest is still whatever it was; staleness follows from its version
                    setState((s) => ({ ...s, loading: false }));
                    return;
                }
                setState({ digest: rtn.digest, loading: false, error: undefined, lastUpdatedTs: Date.now() });
            })
            .catch((err: unknown) => {
                if (cancelled) {
                    return;
                }
                setState((s) => ({ ...s, loading: false, error: String(err) }));
            });
        return () => {
            cancelled = true;
        };
    }, [channelId, runId, dagOref, observedVersion, refreshNonce]);

    return { ...state, stale: digestStale(state.digest, observedVersion), retry };
}
