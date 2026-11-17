// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Rendered mode's message box (the boards' pill): the text, then attach, the model and permission-mode chips, the
// context ring and one button, Send or (while a turn is live and the box is empty) Stop. Attachments sit above
// the text and reach the agent as paths appended to the prompt, as an agent picked with @ (filemention.tsx) does.
// While Claude's question is shown Send is held, since typing into the pty would land in its picker. In ! bash mode the text runs in the agent's shell instead, and the
// tray's attachments wait for the next message. With the agent's brainstorm asking (or open to pushback) the line
// goes to it as the pane's own answer (brainstormRoute).

import { pushToast } from "@/app/cockpit/notificationstore";
import { composerReveal, microFade } from "@/app/element/motiontokens";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, useState, type KeyboardEvent } from "react";
import { canSendComposer, useAgentComposer, useComposerHandle, type AgentComposerHandle } from "./agentcomposer";
import { sendAgentBash } from "./agentsend";
import type { AgentVM } from "./agentsviewmodel";
import { AttachButton, AttachmentTray } from "./attachmenttray";
import { bashOffKey, bashOnInput } from "./bashmodemodel";
import { builderCheckView } from "./brainstormmodel";
import { brainstormAtom } from "./brainstormstore";
import { appendAttachments, pickFilePaths, useComposerAttachments } from "./composerattachments";
import { MIRRORED_TEXTAREA, useAgentCwd, useFileMention } from "./filemention";
import { BoxControls } from "./headercontrols";
import {
    answersLabel,
    boxButton,
    brainstormRoute,
    composerBox,
    contextRing,
    sendRoutedLine,
    type BrainstormRoute,
} from "./renderedmode";
import { useSlashPanel } from "./slashpanel";

const BoxMinH = 22; // one line of 14px text
const BoxMaxShare = 0.4; // of the window: grows to here, then the textarea scrolls
// the ring's circle (r 5.5 in a 14 box): its circumference sets the dash the percent fills
const RING_R = 5.5;
const RING_C = 2 * Math.PI * RING_R;

function ContextRing({ agent }: { agent: AgentVM }) {
    const ring = contextRing(agent.usage);
    if (ring == null) {
        return null;
    }
    return (
        <span
            data-context-ring
            title={ring.title}
            className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-muted"
        >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <circle cx="7" cy="7" r={RING_R} fill="none" strokeWidth="2" className="stroke-edge-strong" />
                <circle
                    cx="7"
                    cy="7"
                    r={RING_R}
                    fill="none"
                    strokeWidth="2"
                    strokeDasharray={`${ring.arc * RING_C} ${RING_C}`}
                    transform="rotate(-90 7 7)"
                    className="stroke-accent"
                />
            </svg>
            {ring.pct}%
        </span>
    );
}

// the agent's brainstorm route for the box, with the builder check as the pane reads it
function useBrainstormRoute(agent: AgentVM): BrainstormRoute | null {
    const s = useAtomValue(brainstormAtom(agent.id));
    if (s == null) {
        return null;
    }
    const check = builderCheckView(
        agent.builderCheck,
        s.sentCheckAt,
        s.file,
        s.modifiedMs,
        agent,
        s.turnStartMs,
        s.checkTakenTs
    );
    return brainstormRoute(s, check);
}

export const RenderedComposer = forwardRef<
    AgentComposerHandle,
    { agent: AgentVM; hasTranscript: boolean; onInterrupt: () => void; onSubmitText?: (text: string) => void }
>(function RenderedComposer({ agent, hasTranscript, onInterrupt, onSubmitText }, ref) {
    const blockId = agent.blockId;
    const [bash, setBash] = useState(false);
    const box = composerBox(agent, hasTranscript, bash, useBrainstormRoute(agent));
    const route = box.route;
    const { attachments, addPaths, remove, retry, onPaste, clear } = useComposerAttachments();
    // bash mode sends the bare command (no attachment paths, no picker flip) and keeps the tray for the next message.
    // A line the brainstorm routes goes as the pane's own answer, its attachments' paths appended as a prompt's are
    const { text, setText, taRef, send, onKeyDown } = useAgentComposer({
        blockId,
        minH: BoxMinH,
        maxH: Math.round(window.innerHeight * BoxMaxShare),
        onEscape: onInterrupt,
        ...(bash
            ? { send: sendAgentBash, onSent: () => setBash(false) }
            : {
                  ...(route != null ? { send: (_: string, t: string) => sendRoutedLine(agent, route, t) } : {}),
                  onSubmitText,
                  compose: (t: string) => appendAttachments(mention.compose(t), attachments),
                  onSent: () => {
                      clear();
                      mention.clear();
                  },
                  attachments,
              }),
    });
    useComposerHandle(ref, setText, taRef);
    // before the mention hook: its pick moves the caret in a layout effect the mention hook then reads
    const slash = useSlashPanel({ text, setText, taRef, blockId, off: bash });
    const cwd = useAgentCwd(agent.transcriptPath, blockId);
    const mention = useFileMention({ agent, text, setText, taRef, cwd, off: bash });
    const canSend = !box.askBlocks && canSendComposer(text, blockId, bash ? [] : attachments);
    const onChange = (next: string) => {
        const on = bash ? null : bashOnInput(text, next);
        if (on != null) {
            setBash(true);
        }
        setText(on?.text ?? next);
    };
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
    const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        // the panels' keys first: their Esc closes them and must not reach onKeyDown's interrupt
        if (slash.onKeyDown(e) || mention.onKeyDown(e)) {
            return;
        }
        // in bash mode Esc leaves the mode instead of interrupting; the Stop button still interrupts
        if (bash && bashOffKey(e.key, text, slash.open || mention.open)) {
            e.preventDefault();
            setBash(false);
            return;
        }
        if (box.askBlocks && e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            return;
        }
        onKeyDown(e);
    };
    const filled = text !== "" || (!bash && attachments.length > 0);
    const button = boxButton(box, filled);
    const answers = answersLabel(box, filled);
    return (
        <div
            data-composer-box
            data-bash-mode={bash ? "" : undefined}
            data-composer-route={route?.kind}
            className={cn(
                "relative rounded-[14px] border border-edge-strong bg-surface-raised pb-2.5 pl-3.5 pr-3 pt-3 focus-within:border-accent/60",
                filled && "border-accent/60",
                answers != null && "border-warning focus-within:border-warning",
                bash && "border-accent focus-within:border-accent"
            )}
        >
            {slash.panel}
            {mention.panel}
            {box.askBlocks ? (
                <div data-composer-notice className="flex items-center gap-[7px] pb-2 text-[12px] text-muted">
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
                    Answer Claude's question first
                </div>
            ) : null}
            {attachments.length > 0 ? (
                <div className="pb-2.5">
                    <AttachmentTray items={attachments} onRemove={remove} onRetry={retry} />
                </div>
            ) : null}
            {/* the textarea inherits this face, so the pill mirror behind it wraps the text the same way */}
            <div className={cn("relative text-[14px] leading-[1.55] text-foreground", bash && "flex gap-2 font-mono")}>
                {bash ? (
                    <span data-bash-label className="shrink-0 text-accent">
                        ! Bash
                    </span>
                ) : null}
                {mention.backdrop}
                <textarea
                    ref={taRef}
                    rows={1}
                    value={text}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={keyDown}
                    onSelect={(e) => {
                        slash.onCaret();
                        mention.onCaret();
                    }}
                    onPaste={bash ? undefined : onPaste}
                    placeholder={box.placeholder}
                    className={cn(
                        "relative block w-full min-w-0 resize-none overflow-y-auto bg-transparent pb-3.5 outline-none placeholder:text-muted",
                        mention.backdrop != null && MIRRORED_TEXTAREA
                    )}
                />
            </div>
            <div className="flex items-center gap-2">
                {bash ? null : <AttachButton onClick={pickFiles} />}
                {blockId != null ? <BoxControls agent={agent} /> : null}
                <AnimatePresence initial={false}>
                    {answers != null ? (
                        <motion.span
                            key="answers"
                            data-composer-answers
                            variants={microFade}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="shrink-0 whitespace-nowrap text-[12px] text-warning"
                        >
                            {answers}
                        </motion.span>
                    ) : null}
                </AnimatePresence>
                <AnimatePresence initial={false}>
                    {box.hint != null ? (
                        <motion.span
                            key="hint"
                            data-composer-hint
                            title={box.hint}
                            variants={composerReveal}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="min-w-0 overflow-hidden truncate text-[12px] text-muted"
                        >
                            {box.hint}
                        </motion.span>
                    ) : null}
                </AnimatePresence>
                <span className="flex-1" />
                <ContextRing agent={agent} />
                {button === "stop" ? (
                    <button
                        type="button"
                        data-composer-interrupt
                        aria-label="Interrupt (Esc)"
                        title="Interrupt (Esc)"
                        onClick={onInterrupt}
                        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded border border-edge-strong bg-surface-hover hover:bg-edge-mid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                        <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-foreground" />
                    </button>
                ) : (
                    <button
                        type="button"
                        data-composer-send
                        aria-label={box.sendLabel}
                        title={box.sendLabel}
                        onClick={send}
                        disabled={!canSend}
                        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded bg-accent text-background shadow-inset-highlight hover:bg-accenthover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:border disabled:border-edge-strong disabled:bg-surface-hover disabled:text-muted disabled:shadow-none"
                    >
                        <ArrowUp size={15} strokeWidth={2.6} aria-hidden />
                    </button>
                )}
            </div>
        </div>
    );
});
