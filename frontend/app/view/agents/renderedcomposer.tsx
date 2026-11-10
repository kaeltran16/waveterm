// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Rendered mode's writing card: the composer at timeline text size, with attach, key hints, and Send that becomes
// Steer (beside Interrupt) while the agent works. Attachments reach the agent as paths appended to the prompt.

import { pushToast } from "@/app/cockpit/notificationstore";
import { cn, fireAndForget } from "@/util/util";
import { ArrowUp, CornerDownLeft } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { canSendComposer, useAgentComposer, useComposerHandle, type AgentComposerHandle } from "./agentcomposer";
import { AttachButton, AttachmentTray } from "./attachmenttray";
import { appendAttachments, pickFilePaths, useComposerAttachments } from "./composerattachments";

const CardMinH = 42; // two lines of 13.5px text
const CardMaxShare = 0.4; // of the window: grows to here, then the textarea scrolls

const PLACEHOLDER_IDLE = "Message the agent";
const PLACEHOLDER_WORKING = "Steer the agent; it reads this before its next step";

function KeyChip({ children }: { children: ReactNode }) {
    return (
        <span className="rounded-[4px] border border-edge-mid px-[5px] font-mono text-[10px] leading-4 text-ink-mid">
            {children}
        </span>
    );
}

export const RenderedComposer = forwardRef<
    AgentComposerHandle,
    { blockId?: string; working: boolean; onInterrupt: () => void; onSubmitText?: (text: string) => void }
>(function RenderedComposer({ blockId, working, onInterrupt, onSubmitText }, ref) {
    const { attachments, addPaths, remove, retry, onPaste, clear } = useComposerAttachments();
    const { text, setText, taRef, send, onKeyDown } = useAgentComposer({
        blockId,
        minH: CardMinH,
        maxH: Math.round(window.innerHeight * CardMaxShare),
        onEscape: onInterrupt,
        onSubmitText,
        compose: (t) => appendAttachments(t, attachments),
        onSent: clear,
        attachments,
    });
    useComposerHandle(ref, setText, taRef);
    const canSend = canSendComposer(text, blockId, attachments);
    const pickFiles = () =>
        fireAndForget(async () => {
            try {
                const paths = await pickFilePaths();
                if (paths.length > 0) {
                    addPaths(paths);
                }
            } catch (e) {
                pushToast({ title: "Could not open the file picker", message: String(e), level: "error" });
            }
        });
    const filled = text !== "" || attachments.length > 0;
    return (
        <div
            className={cn(
                "flex flex-col rounded-lg border border-edge-strong bg-surface-raised focus-within:border-accent/60",
                filled && "border-accent/60"
            )}
        >
            <div className="px-3.5 pt-2.5">
                <textarea
                    ref={taRef}
                    rows={1}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    placeholder={working ? PLACEHOLDER_WORKING : PLACEHOLDER_IDLE}
                    className="block w-full resize-none overflow-y-auto bg-transparent text-[13.5px] leading-[1.55] text-primary outline-none placeholder:text-muted"
                />
            </div>
            {attachments.length > 0 ? (
                <div className="px-3 pt-4">
                    <AttachmentTray items={attachments} onRemove={remove} onRetry={retry} />
                </div>
            ) : null}
            <div className="flex items-center gap-2.5 pb-2 pl-2.5 pr-2 pt-1">
                <AttachButton onClick={pickFiles} />
                <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-ink-faint">
                    <KeyChip>/</KeyChip> commands
                    <span className="ml-2" />
                    <KeyChip>⇧ ↵</KeyChip> new line
                    <span className="ml-2 truncate">pickers open the terminal</span>
                </span>
                {working ? (
                    <>
                        <button
                            type="button"
                            data-composer-interrupt
                            onClick={onInterrupt}
                            className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] border border-edge-strong px-2.5 text-[12px] text-secondary hover:bg-surface-hover hover:text-primary"
                        >
                            Interrupt
                            <KeyChip>Esc</KeyChip>
                        </button>
                        <button
                            type="button"
                            data-composer-send
                            onClick={send}
                            disabled={!canSend}
                            className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] border border-edge-strong bg-surface-raised px-2.5 text-[12px] text-secondary hover:bg-surface-hover hover:text-primary disabled:cursor-default disabled:opacity-40"
                        >
                            <CornerDownLeft size={13} />
                            Steer
                        </button>
                    </>
                ) : (
                    <button
                        type="button"
                        data-composer-send
                        onClick={send}
                        disabled={!canSend}
                        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] bg-accent px-3 text-[12px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-accent"
                    >
                        <ArrowUp size={13} />
                        Send
                    </button>
                )}
            </div>
        </div>
    );
});
