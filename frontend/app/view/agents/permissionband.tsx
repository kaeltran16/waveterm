// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Claude's permission prompt, docked above the rendered view's composer. A choice is typed into Claude's own prompt
// in the pty by the server; the band only ever answers a queue of one, since keys typed for a request the TUI is not
// showing would answer the one on screen.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { MarkdownMessage } from "./markdownmessage";
import {
    bandRequests,
    permissionLogText,
    permissionPreview,
    permissionTitle,
    type PermissionPreview,
} from "./permissionmodel";
import { getAgentPermissionsAtom, permissionLogAtom, removeAgentPermission } from "./permissionstore";
import { pickerFlipAtom } from "./renderedmode";
import { getAgentStatusAtom } from "./session-models/agentstatusstore";
import { CODE_TEXT, ToolDetailBody } from "./tooldetailbody";
import { stepTitle } from "./transcriptlayout";

const BAND = "flex flex-col gap-[9px] rounded-[10px] border border-warning/45 bg-warning/[0.12] px-[13px] py-[11px]";
// the transcript's ToolPanel look, so a command or diff reads the same here as in the timeline once it runs
const PREVIEW = "max-h-[240px] overflow-y-auto rounded-[8px] border border-edge-mid bg-surface-code";
// a tool's arguments, in the transcript's code text
const PRE = `m-0 whitespace-pre-wrap px-3 py-2 font-mono leading-[1.7] text-ink-mid [overflow-wrap:anywhere] ${CODE_TEXT}`;

function NeedsYou({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
            <span className="shrink-0 font-mono text-[11px] font-semibold text-warning">Needs you</span>
            <span className="min-w-0 text-[13px] text-primary [overflow-wrap:anywhere]">{children}</span>
        </div>
    );
}

function Preview({ preview }: { preview: PermissionPreview }) {
    if (preview.kind === "diff") {
        return (
            <div className={PREVIEW}>
                <ToolDetailBody detail={{ kind: "edit", files: preview.files }} variant="inline" />
            </div>
        );
    }
    if (preview.kind === "command") {
        return (
            <div className={PREVIEW}>
                <ToolDetailBody
                    detail={{ kind: "bash", command: preview.text, output: "", exit: null }}
                    variant="inline"
                />
            </div>
        );
    }
    if (preview.kind === "tool") {
        const named = preview.call ? stepTitle(preview.call) : null;
        return (
            <div className={PREVIEW}>
                {named ? (
                    // the line the step row will draw once the call runs
                    <div
                        data-permission-step
                        className="flex gap-2.5 border-b border-edge-faint px-3 py-2 text-[13.5px] text-secondary"
                    >
                        <span className="shrink-0">{named.title}</span>
                        {named.mono ? (
                            <span className={cn("min-w-0 truncate font-mono text-muted", CODE_TEXT)}>{named.mono}</span>
                        ) : null}
                    </div>
                ) : null}
                <pre className={PRE}>{preview.args}</pre>
            </div>
        );
    }
    if (preview.kind === "markdown") {
        return (
            <div className={cn(PREVIEW, "px-3 py-2 text-[13px] leading-[1.55] text-secondary")}>
                <MarkdownMessage text={preview.text} />
            </div>
        );
    }
    return (
        <div className={PREVIEW}>
            <pre className={PRE}>{preview.text}</pre>
        </div>
    );
}

function RequestBand({
    agentId,
    request,
    onLastChoice,
}: {
    agentId: string;
    request: AgentPermissionData;
    onLastChoice: () => void;
}) {
    // the agent's working dir, so its absolute paths read relative
    const cwd = useAtomValue(getAgentStatusAtom(request.oref))?.cwd;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const answer = async (choice: number) => {
        if (busy) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await RpcApi.AnswerAgentPermissionCommand(TabRpcClient, {
                oref: request.oref,
                permid: request.permid,
                choice,
            });
        } catch (e) {
            setError(`Could not answer the prompt: ${e instanceof Error ? e.message : String(e)}`);
            setBusy(false);
            return;
        }
        globalStore.set(permissionLogAtom(agentId), (prev) => [
            ...prev,
            { ts: Date.now(), text: permissionLogText(request, choice, cwd) },
        ]);
        // the server's cleared event retires it too; dropping it here keeps the band from lingering on a slow event
        removeAgentPermission(request.oref, request.permid);
        if (choice === request.choices.length - 1) {
            onLastChoice();
        }
    };
    return (
        <div data-permission-band className={BAND}>
            <NeedsYou>{permissionTitle(request, cwd)}</NeedsYou>
            <Preview preview={permissionPreview(request, cwd)} />
            <div className="flex flex-wrap gap-[7px]">
                {request.choices.map((label, i) => (
                    <button
                        key={i}
                        type="button"
                        data-permission-choice={i}
                        disabled={busy}
                        onClick={() => void answer(i)}
                        className={cn(
                            "rounded-[6px] px-[11px] py-[5px] text-[12px] disabled:cursor-default disabled:opacity-60",
                            i === 0
                                ? "cursor-pointer bg-accent font-semibold text-background hover:bg-accenthover"
                                : "cursor-pointer border border-edge-mid bg-surface-raised text-secondary hover:bg-surface-hover"
                        )}
                    >
                        {i + 1} {label}
                    </button>
                ))}
            </div>
            {error != null ? (
                <div data-permission-error className="text-[11.5px] text-error">
                    {error}
                </div>
            ) : null}
        </div>
    );
}

export function PermissionBand({
    agentId,
    blockId,
    onLastChoice,
}: {
    agentId: string;
    blockId: string;
    onLastChoice: () => void;
}) {
    const pending = bandRequests(useAtomValue(getAgentPermissionsAtom(`block:${blockId}`)));
    if (pending.length === 0) {
        return null;
    }
    return (
        <div>
            {pending.length === 1 ? (
                <RequestBand
                    key={pending[0].permid}
                    agentId={agentId}
                    request={pending[0]}
                    onLastChoice={onLastChoice}
                />
            ) : (
                <div data-permission-queue className={BAND}>
                    <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                            <NeedsYou>
                                {pending.length} permission prompts waiting: answer them in the terminal
                            </NeedsYou>
                        </div>
                        <button
                            type="button"
                            onClick={() => globalStore.set(pickerFlipAtom(agentId), Date.now())}
                            className="shrink-0 cursor-pointer rounded-[6px] border border-edge-mid bg-surface-raised px-[11px] py-[5px] text-[12px] text-secondary hover:bg-surface-hover"
                        >
                            Open terminal
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
