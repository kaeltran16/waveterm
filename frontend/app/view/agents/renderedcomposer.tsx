// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Rendered mode's message box (the boards' pill): the checkout's changes when it has any, the text, then attach, the
// model and permission-mode chips, the
// context ring and one button, Send or (while a turn is live and the box is empty) Stop. Attachments sit above
// the text and reach the agent as paths appended to the prompt, as an agent picked with @ (filemention.tsx) does.
// While the agent's question is shown Send is held, since typing into the pty would land in its picker. In ! bash mode the text runs in the agent's shell instead, and the
// tray's attachments wait for the next message. ↑ in the empty box takes back what the arc mod holds, or with nothing
// held steps through the session's typed prompts (boxrecallmodel.ts); a message the mod lost comes back into the box.
// With the agent's brainstorm asking (or open to pushback) the line goes to it as the pane's own answer
// (brainstormRoute).

import { pushToast } from "@/app/cockpit/notificationstore";
import { composerReveal, microFade } from "@/app/element/motiontokens";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { useEscapeClose } from "@/app/hook/useEscapeClose";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUp, ChevronRight, FileDiff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
    forwardRef,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type RefObject,
} from "react";
import { canSendComposer, useAgentComposer, useComposerHandle, type AgentComposerHandle } from "./agentcomposer";
import { FilesSummary } from "./agentdetailsrail";
import { agentDiffScope, openDiff } from "./agentdiffnav";
import type { ContextFacts } from "./agentrailmodel";
import type { AgentsViewModel } from "./agents";
import { sendAgentBash } from "./agentsend";
import type { AgentVM } from "./agentsviewmodel";
import { AttachButton, AttachmentTray } from "./attachmenttray";
import { bashOffKey, bashOnInput } from "./bashmodemodel";
import { boxKey, promptHistory } from "./boxrecallmodel";
import { builderCheckView } from "./brainstormmodel";
import { brainstormAtom } from "./brainstormstore";
import { appendAttachments, pickFilePaths, useComposerAttachments } from "./composerattachments";
import { MIRRORED_TEXTAREA, useAgentCwd, useFileMention } from "./filemention";
import { BoxControls } from "./headercontrols";
import { entriesAtomFor } from "./livetranscriptatoms";
import { useCheckoutFacts, useRailGit } from "./railgit";
import {
    answersLabel,
    boxButton,
    brainstormRoute,
    composerBox,
    contextRing,
    sendRoutedLine,
    type BrainstormRoute,
} from "./renderedmode";
import { ContextLine, SessionLine, useSessionLoaders, useSessionView } from "./sessionfacts";
import { useSlashPanel } from "./slashpanel";
import { TokenUsageSection } from "./tokenusagesection";
import { openBeside } from "./workspacestore";

const BoxMinH = 22; // one line of 14px text
const BoxMaxShare = 0.4; // of the window: grows to here, then the textarea scrolls
// the ring's circle (r 5.5 in a 14 box): its circumference sets the dash the percent fills
const RING_R = 5.5;
const RING_C = 2 * Math.PI * RING_R;

const RING_STROKE: Record<ContextFacts["level"], string> = {
    ok: "stroke-accent",
    warn: "stroke-warning",
    hot: "stroke-error",
};
// closed, the ring's percent reads muted until the context is worth a look
const RING_TEXT: Record<ContextFacts["level"], string> = { ok: "text-muted", warn: "text-warning", hot: "text-error" };

// the popover's facts and their loaders mount only while it is open, so a closed ring keeps no 1 s clock
function SessionPopoverBody({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const view = useSessionView(model, agent);
    useSessionLoaders(agent, { id: agent.id, path: agent.transcriptPath });
    return (
        <>
            <div className="flex flex-col gap-[6px]">
                <SessionLine view={view} />
                {view.context ? <ContextLine ctx={view.context} blockId={agent.blockId} /> : null}
            </div>
            <div className="border-t border-border pt-[12px]">
                <TokenUsageSection />
            </div>
        </>
    );
}

// the context ring is the session popover's button: Session, Context and Token usage, the details rail's facts for
// this view. Esc or the ring again closes it and hands focus back to the box; a click outside closes it and leaves
// focus where the click put it
function ContextRing({
    model,
    agent,
    boxRef,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    boxRef: RefObject<HTMLTextAreaElement | null>;
}) {
    const ring = contextRing(agent.usage);
    const [open, setOpen] = useState(false);
    const ringRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useEscapeClose(open, close, boxRef);
    useEffect(() => {
        if (!open) {
            return;
        }
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node | null;
            if (!panelRef.current?.contains(t) && !ringRef.current?.contains(t)) {
                close();
            }
        };
        window.addEventListener("pointerdown", onDown, true);
        return () => window.removeEventListener("pointerdown", onDown, true);
    }, [open, close]);
    const toggle = () => {
        if (open) {
            close();
            boxRef.current?.focus();
        } else {
            setOpen(true);
        }
    };
    // positioned against the box, so the popover sits above the whole composer, right-aligned
    return (
        <>
            <button
                ref={ringRef}
                type="button"
                data-context-ring
                aria-expanded={open}
                title="Session, context and token usage"
                onClick={toggle}
                className={cn(
                    "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border px-[7px] py-[4px] text-[12px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    open
                        ? "border-edge-strong bg-surface-hover text-secondary"
                        : cn("border-transparent hover:bg-surface-hover", RING_TEXT[ring.level])
                )}
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
                        className={RING_STROKE[ring.level]}
                    />
                </svg>
                {ring.pct != null ? `${ring.pct}%` : null}
            </button>
            <PopoverReveal
                open={open}
                origin="bottom right"
                className="absolute bottom-[calc(100%+8px)] right-0 z-10 w-[320px]"
            >
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label="Session"
                    data-session-popover
                    className="flex flex-col gap-[12px] rounded-[12px] border border-edge-mid bg-surface-raised p-[14px] shadow-popover"
                >
                    <SessionPopoverBody model={model} agent={agent} />
                </div>
            </PopoverReveal>
        </>
    );
}

// the checkout's changes as the box's first row, where the next message is decided; no row while there are none
function ChangesRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    useRailGit(agent);
    const chip = useCheckoutFacts(model, agent).chip;
    return (
        <AnimatePresence initial={false}>
            {chip ? (
                <motion.div
                    key="changes"
                    variants={composerReveal}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="overflow-hidden"
                >
                    <button
                        type="button"
                        data-composer-changes
                        onClick={(e) => {
                            if (!openBeside(model, agent.id, { kind: "changes", selected: null }, e)) {
                                openDiff(model, agentDiffScope(agent.id, agent.name, agent.agent));
                            }
                        }}
                        title={chip.title ? `${chip.title} · Open the Changes tab` : "Open the Changes tab"}
                        className="group mb-2.5 flex w-full cursor-pointer items-center gap-[9px] border-b border-edge-mid pb-2.5 text-left text-ink-mid"
                    >
                        <FileDiff size={13} strokeWidth={2} aria-hidden className="shrink-0" />
                        <span
                            data-composer-changes-summary
                            className="min-w-0 truncate font-mono text-[11px] font-semibold text-secondary"
                        >
                            <FilesSummary chip={chip} />
                        </span>
                        <span className="flex-1" />
                        <span className="inline-flex shrink-0 items-center gap-[3px] rounded-[6px] px-[6px] py-[2px] text-[12px] font-semibold text-accent-soft group-hover:bg-surface-hover">
                            Review changes
                            <ChevronRight size={12} strokeWidth={2} aria-hidden />
                        </span>
                    </button>
                </motion.div>
            ) : null}
        </AnimatePresence>
    );
}

// ↑ / ↓ in the box (boxrecallmodel.ts), and the mod's lost messages put back into it while it is mounted
function useBoxRecall(agentId: string, text: string, setText: (fn: (cur: string) => string) => void) {
    const entries = useAtomValue(entriesAtomFor(agentId));
    const history = useMemo(() => promptHistory(entries), [entries]);
    const [recall, setRecall] = useState<number | null>(null);
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
            return false;
        }
        const act = boxKey(e.key, { text, history, recall });
        if (act == null) {
            return false;
        }
        e.preventDefault();
        setRecall(act.recall);
        setText(() => act.text);
        return true;
    };
    return { onKeyDown };
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
    {
        model: AgentsViewModel;
        agent: AgentVM;
        hasTranscript: boolean;
        onInterrupt: () => void;
        onSubmitText?: (text: string) => void;
    }
>(function RenderedComposer({ model, agent, hasTranscript, onInterrupt, onSubmitText }, ref) {
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
    const recall = useBoxRecall(agent.id, text, setText);
    // before the mention hook: its pick moves the caret in a layout effect the mention hook then reads
    const slash = useSlashPanel({ text, setText, taRef, blockId, harness: agent.agent, off: bash });
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
        if (!bash && recall.onKeyDown(e)) {
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
            <ChangesRow model={model} agent={agent} />
            {box.askBlocks ? (
                <div data-composer-notice className="flex items-center gap-[7px] pb-2 text-[12px] text-muted">
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
                    {box.notice}
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
                <ContextRing model={model} agent={agent} boxRef={taRef} />
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
