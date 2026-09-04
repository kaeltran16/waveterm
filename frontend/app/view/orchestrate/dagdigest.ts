// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The orchestrator status digest hook: loads DagStatusCommand's {Group, Digest} and accepts a response
// only when it is fresh (Digest.DagVersion == observed TaskGroup.Version) and belongs to the newest
// outstanding request (spec 9). A stale/failed digest never replaces task facts — the caller renders
// them behind "Refreshing status".

import { useEffect, useRef, useState } from "react";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useRunEvents } from "../agents/runeventstore";
import { useDagGroup } from "./dagstore";

export type DigestState = {
    digest?: DagStatusDigest;
    loading: boolean;
    stale: boolean;
    error?: string;
};

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

// nextStepText renders the typed next-step kind as a short imperative line for the overview header
// ("waiting on you — approve / sendback"). Presentation only: the digest contract stays typed, never
// re-derived here.
export function nextStepText(next: DagNextStep): string {
    switch (next.kind) {
        case "human-action":
            return `waiting on you — ${next.actions?.join(" / ") ?? "action"}`;
        case "merge-ready":
            return "merge ready for review";
        case "dispatch":
            return "dispatching next task";
        case "parallelism-wait":
            return "waiting on parallelism limit";
        case "dependency-wait":
            return "waiting on dependencies";
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

// healthView is the single decision about what the health strip says. Two rules it must never break:
// an unavailable digest is never rendered as healthy, and a stale digest's health is replaced by
// "Refreshing status" rather than shown as if it were current.
export function healthView(state: DigestState): { text: string; tone: string } {
    if (state.digest == null) {
        return { text: state.loading ? "Loading status…" : "DAG status unavailable", tone: "text-muted" };
    }
    if (state.stale) {
        return { text: "Refreshing status", tone: "text-muted" };
    }
    return { text: state.digest.health, tone: HEALTH_TONE[state.digest.health] ?? "text-muted" };
}

// nextStepView returns the next-engine-move line, or null when there is no claim the UI is entitled
// to make. A stale digest's "next" is a statement about a DAG version that has already moved on.
export function nextStepView(state: DigestState): string | null {
    if (state.digest == null || state.stale) {
        return null;
    }
    return nextStepText(state.digest.next);
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
// observed TaskGroup.Version change (via the live WOS group), and on digest-relevant run events. A
// running request token guards out-of-order responses. Errors degrade to stale=true with the last good
// digest kept.
export function useDagDigest(channelId: string, runId: string, dagOref: string): DigestState {
    const [group] = useDagGroup(dagOref);
    const observedVersion = group?.version;
    const events = useRunEvents(runId, channelId);
    const [state, setState] = useState<DigestState>({ loading: true, stale: false });
    const requestTokenRef = useRef(0);
    const newestTokenRef = useRef(0);
    const seenEventsRef = useRef(new Set<string>());
    // unseen digest-relevant events bump this nonce and re-trigger the load effect
    const [refreshNonce, setRefreshNonce] = useState(0);

    // mark newly seen digest-relevant events once; each bump triggers the load effect below
    const nextNonce = useRef(0);
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
                    setState((s) => ({ ...s, loading: false, stale: true }));
                    return;
                }
                setState({ digest: rtn.digest, loading: false, stale: false, error: undefined });
            })
            .catch((err: unknown) => {
                if (cancelled) {
                    return;
                }
                setState((s) => ({ ...s, loading: false, stale: true, error: String(err) }));
            });
        return () => {
            cancelled = true;
        };
    }, [channelId, runId, dagOref, observedVersion, refreshNonce]);

    return state;
}