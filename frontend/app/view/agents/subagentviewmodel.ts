// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the subagent view's banner and now line say, from the subagent's SubagentVM. A subagent has no terminal
// spinner to read, so its now line comes from the transcript: the running call (named as its step row names it), else
// "working", else its outcome. subagentview.tsx draws both. When the parent's list lacks the child, its state is read
// from the child's own streamed entries.

import type { AgentActionEntry, AgentEntry } from "./agentsviewmodel";
import { toolCount } from "./nowline";
import { fmtDuration } from "./runcompletion";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { subagentElapsedMs, subagentOutcome, type SubagentOutcome } from "./subagentmodel";
import type { FocusSubagent } from "./subagentsstore";
import { stepTitle } from "./transcriptlayout";

const SEP = " · ";

export interface SubagentBanner {
    outcome: SubagentOutcome;
    type: string;
    parent: string;
    // the outcome word, with the elapsed time or duration when it is known
    status: string;
    tools: string;
}

export interface SubagentViewLine {
    // the running call's title, "working" between calls, or the outcome word once finished
    title: string;
    mono?: string;
    facts: string;
}

const joinFacts = (parts: (string | undefined)[]) => parts.filter((p) => p != null).join(SEP);
const fmt = (ms: number | undefined) => (ms == null ? undefined : fmtDuration(ms));

export function subagentBanner(sub: SubagentVM, parentName: string, now: number): SubagentBanner {
    const outcome = subagentOutcome(sub);
    return {
        outcome,
        type: sub.type,
        parent: `subagent of ${parentName}`,
        status: joinFacts([outcome, fmt(subagentElapsedMs(sub, now))]),
        tools: toolCount(sub.toolCount ?? 0),
    };
}

export function subagentViewLine(sub: SubagentVM, now: number): SubagentViewLine {
    const tools = toolCount(sub.toolCount ?? 0);
    const outcome = subagentOutcome(sub);
    const call = outcome === "running" ? sub.currentCall : undefined;
    if (call != null) {
        const { title, mono } = stepTitle(call);
        const since = call.startedTs ?? call.ts;
        return {
            title,
            ...(mono != null ? { mono } : {}),
            facts: joinFacts([since == null ? undefined : fmtDuration(Math.max(0, now - since)), tools]),
        };
    }
    const title = outcome === "running" ? "working" : outcome;
    return { title, facts: joinFacts([fmt(subagentElapsedMs(sub, now)), tools]) };
}

const entryTs = (e: AgentEntry | undefined): number | undefined => (e != null && "ts" in e ? e.ts : undefined);

/** A child the parent's list does not hold, read from its own transcript: a pending call is running, a closing reply
 *  is done, the interrupt marker is stopped, and anything else is still working. */
export function subagentFromEntries(
    focus: Pick<FocusSubagent, "agentId" | "label" | "transcriptPath">,
    entries: AgentEntry[]
): SubagentVM {
    const actions = entries.filter((e): e is AgentActionEntry => e.kind === "action");
    const last = entries.at(-1);
    const pending = actions.at(-1)?.pending ? actions.at(-1) : undefined;
    const state =
        pending == null && last?.kind === "message" ? "done" : last?.kind === "interrupted" ? "stopped" : "working";
    const startedAtMs = entryTs(entries[0]);
    const endedAtMs = state === "done" ? entryTs(last) : undefined;
    return {
        id: focus.agentId,
        type: focus.label,
        state,
        transcriptPath: focus.transcriptPath,
        toolCount: actions.length,
        ...(startedAtMs != null ? { startedAtMs } : {}),
        ...(endedAtMs != null ? { endedAtMs } : {}),
        ...(pending != null ? { currentCall: pending } : {}),
    };
}
