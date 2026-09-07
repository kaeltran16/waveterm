// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure logic for the merged Channels surface's two-face composer. The Launch face is a plain goal input
// driven by a curated `@`-command vocabulary — @quick/@run/@ask — that sets the launch mode (a bare goal
// defaults to @run, with Quick selected). parseComposerCommand strips the command; composerFace picks
// Launch vs Talk from whether the selected run has a live worker. No React/jotai — unit-tested in
// composercommand.test.ts.

import type { AgentVM } from "./agentsviewmodel";
import { supportsOperation, type HarnessOperation } from "./harnesspicker";
import type { EffectiveRoute } from "./route";
import { steerTarget } from "./runmodel";

export type LaunchMode = "quick" | "run" | "ask";
export interface ComposerCommand {
    mode: LaunchMode;
    runtime?: string;
    body: string;
}

export type RunShape = "pipeline" | "orchestrator" | "quick";

export type RunCreationDecision =
    | {
          kind: "create-run";
          channelId: string;
          goal: string;
          mode: RunShape;
          route: RoutePin;
      }
    | { kind: "blocked"; focusRoute: boolean; reason: string };

export function resolveRunCreationDecision(input: {
    channelId: string;
    goal: string;
    shape: RunShape;
    route: EffectiveRoute | null;
}): RunCreationDecision {
    if (input.route == null || input.route.capability == null) {
        return { kind: "blocked", focusRoute: true, reason: "Choose an available route" };
    }
    return {
        kind: "create-run",
        channelId: input.channelId,
        goal: input.goal,
        mode: input.shape,
        route: input.route.pin,
    };
}

export const LAUNCH_COMMANDS: { cmd: string; mode: LaunchMode; desc: string }[] = [
    { cmd: "@quick", mode: "quick", desc: "one worker, no phases" },
    { cmd: "@run", mode: "run", desc: "selected mode · quick by default" },
    { cmd: "@ask", mode: "ask", desc: "one-shot consult · no worker" },
];

// Parse a Launch-face draft into its mode + goal. Only a leading `@quick`/`@run`/`@ask` token is a
// command; a mid-text `@` (e.g. "add @mentions") is left in the goal and defaults to run. `@ask` accepts
// an optional runtime override as its first word (`@ask codex …`) — recognized against the installed
// harness catalog (`knownRuntimeIds`), so an unknown first word stays in the body rather than inventing
// an invalid-runtime syntax.
export function parseComposerCommand(text: string, knownRuntimeIds?: Set<string>): ComposerCommand {
    const trimmed = text.trim();
    const m = /^@(quick|run|ask)\b\s*([\s\S]*)$/i.exec(trimmed);
    if (!m) {
        return { mode: "run", body: trimmed };
    }
    const mode = m[1].toLowerCase() as LaunchMode;
    const rest = m[2].trim();
    if (mode === "ask") {
        const rm = /^(\w+)\s+([\s\S]*)$/.exec(rest);
        if (rm && knownRuntimeIds?.has(rm[1].toLowerCase())) {
            return { mode, runtime: rm[1].toLowerCase(), body: rm[2].trim() };
        }
    }
    return { mode, body: rest };
}

// The resolved dispatch for a composer submission. Returns `blocked` before any side effect when the
// effective runtime is missing, invalid for the operation, or a preference write is in flight — so
// callers preserve the draft and open the picker rather than dispatching a guessed harness.
export type ComposerDispatch =
    | { kind: "run"; mode: "quick" | "run"; runtime: string; body: string }
    | { kind: "ask"; runtime: string; body: string; oneOff: boolean }
    | { kind: "blocked"; focusHarness: boolean; reason: string };

export interface ResolveComposerDispatchInput {
    command: ComposerCommand;
    preferredRuntime: string;
    preferenceSaving: boolean;
    harnesses: HarnessInfo[];
}

export function resolveComposerDispatch(input: ResolveComposerDispatchInput): ComposerDispatch {
    const { command, preferredRuntime, preferenceSaving, harnesses } = input;
    // An explicit @ask override is one-off: it never consults the preference and never mutates it.
    if (command.mode === "ask") {
        const runtime = command.runtime ?? preferredRuntime;
        if (command.runtime != null) {
            const h = harnesses.find((x) => x.runtime === command.runtime);
            if (h == null || !h.installed || !supportsOperation(h, "consult")) {
                return { kind: "blocked", focusHarness: true, reason: "Choose a harness" };
            }
            return { kind: "ask", runtime: command.runtime, body: command.body, oneOff: true };
        }
        const dispatch = resolvePreferredForOperation(
            runtime,
            preferredRuntime,
            preferenceSaving,
            harnesses,
            "consult",
            command.body
        );
        if (dispatch.kind === "blocked") {
            return dispatch;
        }
        return { kind: "ask", runtime: dispatch.runtime, body: dispatch.body, oneOff: false };
    }
    // run / quick use the visible preferred harness, validated for unattended workers.
    const runtime = preferredRuntime;
    const dispatch = resolvePreferredForOperation(
        runtime,
        preferredRuntime,
        preferenceSaving,
        harnesses,
        "run-worker",
        command.body
    );
    if (dispatch.kind === "blocked") {
        return dispatch;
    }
    return { kind: "run", mode: command.mode, runtime: dispatch.runtime, body: dispatch.body };
}

function resolvePreferredForOperation(
    runtime: string,
    preferredRuntime: string,
    preferenceSaving: boolean,
    harnesses: HarnessInfo[],
    operation: HarnessOperation,
    body: string
): { kind: "blocked"; focusHarness: boolean; reason: string } | { kind: "ok"; runtime: string; body: string } {
    if (runtime === "") {
        return { kind: "blocked", focusHarness: true, reason: "Choose a harness" };
    }
    if (preferenceSaving) {
        return { kind: "blocked", focusHarness: false, reason: "Saving harness preference…" };
    }
    const h = harnesses.find((x) => x.runtime === runtime);
    if (h == null || !h.installed || !supportsOperation(h, operation)) {
        return { kind: "blocked", focusHarness: true, reason: "Choose a harness" };
    }
    return { kind: "ok", runtime: preferredRuntime, body };
}

// The composer's face: Talk when the selected run has a live worker to message (the old "Steer" target),
// else Launch. A run has at most one live worker at a time (phases are sequential), so the target is
// never ambiguous.
export function composerFace(
    run: Run | undefined,
    agents: AgentVM[]
): { face: "launch" } | { face: "talk"; worker: AgentVM } {
    const worker = run ? steerTarget(run, agents) : undefined;
    return worker ? { face: "talk", worker } : { face: "launch" };
}
