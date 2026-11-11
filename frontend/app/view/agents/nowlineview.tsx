// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered view's now line, in a band between the timeline and the composer. Derived on each tick of the
// surface's 1s clock (nowline.ts), so nothing here must survive an unmount.

import { CrossFade } from "@/app/element/crossfade";
import { DrawCheck } from "@/app/element/drawcheck";
import { screenRows } from "@/app/view/term/termscreen";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { hasAnswerableAsk, type AgentEntry, type AgentVM } from "./agentsviewmodel";
import { VERB } from "./narrationtimeline";
import { nowLineState, nowLineText } from "./nowline";
import { getAgentPermissionsAtom } from "./permissionstore";
import { getLastHookAtom } from "./session-models/agentstatusstore";
import { parseSpinner } from "./spinnerrow";

const MONO = "font-mono text-[11px] text-muted";

export function NowLine({ model, agent, entries }: { model: AgentsViewModel; agent: AgentVM; entries: AgentEntry[] }) {
    const now = useAtomValue(model.nowAtom);
    const oref = `block:${agent.blockId}`;
    const lastHook = useAtomValue(getLastHookAtom(oref));
    const permissions = useAtomValue(getAgentPermissionsAtom(oref));
    // the dock holds the slot: an answerable ask or a pending permission request
    const docked = permissions.length > 0 || (agent.state === "asking" && hasAnswerableAsk(agent));
    // the screen is only read while working; a terminal not yet mounted reads as no spinner
    const rows = agent.state === "working" ? screenRows(agent.blockId) : null;
    const line = nowLineState({
        state: agent.state,
        docked,
        entries,
        spinner: rows == null ? null : parseSpinner(rows),
        lastHook,
        now,
    });
    if (line.kind === "hidden") {
        return null;
    }
    const { left, right } = nowLineText(line);
    return (
        <div data-now-band className="flex h-10 shrink-0 items-center px-[22px]">
            <div data-now-line data-now-kind={line.kind} className="flex min-w-0 flex-1 items-center gap-2.5">
                {/* unconditional, so the turn finishing while the line is on screen draws the check */}
                <DrawCheck done={line.kind === "done"} className="shrink-0 text-ink-mid" />
                {line.kind === "done" ? (
                    <span data-now-left className="font-mono text-[11px] text-ink-faint">
                        {left}
                    </span>
                ) : (
                    <>
                        {line.spinner != null ? (
                            <span data-now-left className="flex shrink-0 items-center gap-2.5 whitespace-nowrap">
                                <span className="font-mono text-[11.5px] text-provider-claude">
                                    {line.spinner.glyph} {line.spinner.verb}
                                </span>
                                {line.spinner.detail != null ? (
                                    <span className={MONO}>({line.spinner.detail})</span>
                                ) : null}
                            </span>
                        ) : (
                            <span
                                data-now-left
                                className="shrink-0 whitespace-nowrap font-mono text-[11.5px] text-muted"
                            >
                                {left}
                            </span>
                        )}
                        <span className="flex-1" />
                        <CrossFade
                            swapKey={line.call == null ? "" : `${line.call.verb} ${line.call.target}`}
                            className="min-w-0 gap-2.5"
                        >
                            {line.call != null ? (
                                <>
                                    <span className={VERB}>{line.call.verb}</span>
                                    <span
                                        data-now-target
                                        className="min-w-0 truncate font-mono text-[11.5px] text-primary"
                                    >
                                        {line.call.target}
                                    </span>
                                </>
                            ) : null}
                        </CrossFade>
                        {right !== "" ? (
                            <span data-now-right className={`shrink-0 whitespace-nowrap ${MONO}`}>
                                {right}
                            </span>
                        ) : null}
                    </>
                )}
            </div>
        </div>
    );
}
