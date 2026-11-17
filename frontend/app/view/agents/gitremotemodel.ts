// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// What the Diff toolbar's Fetch and Push buttons and their failure banner say, from the change list's
// remote facts and the repository's network-action state. Pure: filessurface.tsx only draws it.

import { formatAgo } from "./agentsviewmodel";
import type { FilesState } from "./filesstore";
import type { GitRemoteState, RemoteAction } from "./gitremotestore";

export type RemoteFacts = Pick<FilesState, "branch" | "hasRemote" | "upstream" | "ahead" | "behind">;

// fetch and push are each button's own icon; running and failed replace it
export type RemoteIcon = "fetch" | "push" | "running" | "failed";

export interface FetchButton {
    label: string;
    icon: RemoteIcon;
    title: string;
    disabled: boolean;
    // the last fetch's time, "" before one or while one runs
    detail: string;
}

// ahead > 0 draws the counts (behind > 0 makes them a warning); time is the last push once nothing is ahead
export type PushDetail = { kind: "ahead"; ahead: number; behind: number } | { kind: "time"; text: string } | null;

export interface PushButton {
    label: string;
    icon: RemoteIcon;
    // the reason Push does what it would do, or why it cannot: drawn as its tooltip
    title: string;
    disabled: boolean;
    // no upstream: the button publishes, drawn in brighter ink
    publish: boolean;
    detail: PushDetail;
}

export interface RemoteFailureBanner {
    action: RemoteAction;
    title: string;
    note: string;
    failure: GitFailure;
}

// Publish always targets origin, the default gitinfo.Fetch and gitinfo.Push use
const PUBLISH_REMOTE = "origin";
const DETACHED_PUSH_REASON = "HEAD is detached: check out a branch to push";
// a push's per-ref status for a non-fast-forward ref
const REJECTED_MARK = "[rejected]";

// the change list's branch on a detached HEAD, as diffscope.ts reads it
function isDetached(branch: string): boolean {
    return branch === "" || branch === "HEAD";
}

function commits(n: number): string {
    return `${n} ${n === 1 ? "commit" : "commits"}`;
}

function clock(atSeconds: number, nowMs: number): string {
    return atSeconds > 0 ? formatAgo(nowMs - atSeconds * 1000) : "";
}

// Fetch is drawn only in compare, the one range that reads remote-tracking refs; Push on every range. Neither
// without a remote, and neither while the change list has not said whether there is one.
export function remoteButtonsShown(
    facts: RemoteFacts | null | undefined,
    compareOn: boolean
): { fetch: boolean; push: boolean } {
    const has = facts?.hasRemote === true;
    return { fetch: has && compareOn, push: has };
}

function iconFor(action: RemoteAction, st: GitRemoteState): RemoteIcon {
    if (st.running === action) {
        return "running";
    }
    return st.failure?.action === action ? "failed" : action;
}

export function fetchButton(st: GitRemoteState, nowMs: number): FetchButton {
    const running = st.running === "fetch";
    return {
        label: running ? "Fetching…" : "Fetch",
        icon: iconFor("fetch", st),
        title: "Update remote-tracking refs",
        // one network action at a time per repository
        disabled: st.running != null,
        detail: running ? "" : clock(st.fetchedAt, nowMs),
    };
}

function pushReason(facts: RemoteFacts, ahead: number, behind: number): string {
    if (isDetached(facts.branch)) {
        return DETACHED_PUSH_REASON;
    }
    const upstream = facts.upstream ?? "";
    if (!upstream) {
        return `Publish ${facts.branch} to ${PUBLISH_REMOTE} and track it`;
    }
    if (ahead > 0 && behind > 0) {
        return `${upstream} has ${commits(behind)} you lack: merge before pushing`;
    }
    if (ahead > 0) {
        return `Push ${commits(ahead)} to ${upstream}`;
    }
    return `Nothing to push: ${upstream} has every commit`;
}

export function pushButton(facts: RemoteFacts, st: GitRemoteState, nowMs: number): PushButton {
    const detached = isDetached(facts.branch);
    const publish = !detached && !facts.upstream;
    const ahead = facts.ahead ?? 0;
    const behind = facts.behind ?? 0;
    const running = st.running === "push";
    const label = running ? (publish ? "Publishing…" : "Pushing…") : publish ? "Publish" : "Push";
    let detail: PushDetail = null;
    if (!running && ahead > 0) {
        detail = { kind: "ahead", ahead, behind };
    } else if (!running && st.pushedAt > 0) {
        detail = { kind: "time", text: clock(st.pushedAt, nowMs) };
    }
    return {
        label,
        icon: iconFor("push", st),
        title: pushReason(facts, ahead, behind),
        disabled: detached || st.running != null,
        publish,
        detail,
    };
}

// a rejected push is the remote having moved on, which has one way forward; anything else (auth, network,
// a hook) left the remote as it was
function pushFailureNote(facts: RemoteFacts, failure: GitFailure): string {
    if (!(failure.stderr ?? "").includes(REJECTED_MARK)) {
        return "nothing was pushed";
    }
    const upstream = facts.upstream || `${PUBLISH_REMOTE}/${facts.branch}`;
    return `${upstream} has commits you lack. Fetch, then merge them before pushing.`;
}

export function remoteFailureBanner(facts: RemoteFacts, st: GitRemoteState): RemoteFailureBanner | null {
    const f = st.failure;
    if (f == null) {
        return null;
    }
    if (f.action === "fetch") {
        return { action: "fetch", title: "Fetch failed", note: "showing refs as of the last fetch", failure: f.git };
    }
    return { action: "push", title: "Push failed", note: pushFailureNote(facts, f.git), failure: f.git };
}
