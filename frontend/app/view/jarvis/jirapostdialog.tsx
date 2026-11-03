// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Post progress to Jira (boards PostToJira and RunSheetPosted): the view over jirapost.ts. It opens on the
// code draft at once and lets the model's rewrite cross-fade over it when it lands; Post never waits on it.

import { MOTION, viewFade } from "@/app/element/motiontokens";
import { DialogButton } from "@/app/modals/dialogbutton";
import { ModalShell } from "@/app/modals/modalshell";
import { getApi, getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, CircleAlert } from "lucide-react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadEffortDetail } from "./effortstore";
import {
    failureLine,
    lastPostedLine,
    moveFailedLines,
    moveOptions,
    onDraft,
    onEdit,
    onSummaries,
    postLabel,
    postSentence,
    type MovePick,
    type PostDraft,
} from "./jirapost";
import { parseJiraError, ticketUrl, type JiraFailure } from "./jiraticket";

// the draft reads the ticket and its moves from Jira; the summaries wait on wavesrv's 60s model call
const DRAFT_TIMEOUT_MS = 30_000;
const SUMMARIES_TIMEOUT_MS = 75_000;
const POST_TIMEOUT_MS = 30_000;

// the drafted text over the code draft: opacity only, both directions, so the two overlap instead of blinking
const textCrossfade: Variants = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } },
};

const LABEL = "font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-mid";

type MoveFailed = { rtn: CommandJiraPostRtnData; picked: string };

export function JiraPostDialog({
    oref,
    open,
    ticket,
    onClose,
    onConnectJira,
}: {
    oref: string;
    open: boolean;
    ticket: string;
    onClose: () => void;
    onConnectJira?: () => void;
}) {
    const [post, setPost] = useState<(() => void) | null>(null);
    // portalled: the plan it opens from sits in a row whose layout transform would re-anchor a fixed backdrop
    return createPortal(
        <ModalShell open={open} onClose={onClose} onSubmit={post ?? undefined} className="w-[700px] max-w-[92vw]">
            <PostBody
                oref={oref}
                ticket={ticket}
                onClose={onClose}
                onConnectJira={onConnectJira}
                onPostReady={setPost}
            />
        </ModalShell>,
        document.body
    );
}

function PostBody({
    oref,
    ticket,
    onClose,
    onConnectJira,
    onPostReady,
}: {
    oref: string;
    ticket: string;
    onClose: () => void;
    onConnectJira?: () => void;
    onPostReady: (post: (() => void) | null) => void;
}) {
    const effortoid = oref.replace(/^effort:/, "");
    const site = useAtomValue(getSettingsKeyAtom("jira:site")) as string | undefined;
    const [rtn, setRtn] = useState<CommandJiraPostDraftRtnData | null>(null);
    const [loadError, setLoadError] = useState<JiraFailure | null>(null);
    const [draft, setDraft] = useState<PostDraft | null>(null);
    // bumped when the drafted text replaces the box's text, which is what the crossfade keys on
    const [version, setVersion] = useState(0);
    const [pick, setPick] = useState<MovePick>(moveOptions(undefined)[0]);
    const [posting, setPosting] = useState(false);
    const [postError, setPostError] = useState<JiraFailure | null>(null);
    const [moveFailed, setMoveFailed] = useState<MoveFailed | null>(null);
    // the summaries land in a promise callback, which must see the draft as it is then, edits included
    const draftRef = useRef<PostDraft | null>(null);
    const applyDraft = (next: PostDraft) => {
        draftRef.current = next;
        setDraft(next);
    };

    useEffect(() => {
        let live = true;
        const data = { effortoid };
        RpcApi.JiraPostDraftCommand(TabRpcClient, data, { timeout: DRAFT_TIMEOUT_MS })
            .then((r) => {
                if (!live) {
                    return;
                }
                setRtn(r);
                applyDraft(onDraft(r));
                return RpcApi.JiraPostSummariesCommand(TabRpcClient, data, { timeout: SUMMARIES_TIMEOUT_MS }).then(
                    (s) => {
                        const prev = draftRef.current;
                        if (!live || prev == null) {
                            return;
                        }
                        const next = onSummaries(prev, s);
                        if (next.text !== prev.text) {
                            setVersion((v) => v + 1);
                        }
                        applyDraft(next);
                    },
                    (e) => {
                        const prev = draftRef.current;
                        if (live && prev != null) {
                            const why = failureLine(parseJiraError(e));
                            applyDraft({ ...prev, drafting: false, note: `Summaries were not rewritten: ${why}` });
                        }
                    }
                );
            })
            .catch((e) => live && setLoadError(parseJiraError(e)));
        return () => {
            live = false;
        };
    }, [effortoid]);

    const canPost = rtn != null && draft != null && draft.text.trim() !== "" && !posting && moveFailed == null;
    const submit = useCallback(async () => {
        if (!canPost) {
            return;
        }
        setPosting(true);
        setPostError(null);
        try {
            const r = await RpcApi.JiraPostCommand(
                TabRpcClient,
                {
                    effortoid,
                    comment: draft.text,
                    transitionid: pick.id || undefined,
                    donechunks: rtn.donechunks ?? [],
                },
                { timeout: POST_TIMEOUT_MS }
            );
            // the record is already written, so a failed refresh only delays the footer until the next load
            fireAndForget(() => loadEffortDetail(oref, r.postedts));
            if (r.moveerror) {
                setMoveFailed({ rtn: r, picked: pick.label });
            } else {
                onClose();
            }
        } catch (e) {
            setPostError(parseJiraError(e));
        } finally {
            setPosting(false);
        }
    }, [canPost, effortoid, draft, pick, rtn, oref, onClose]);

    useEffect(() => {
        onPostReady(() => () => fireAndForget(submit));
        return () => onPostReady(null);
    }, [submit, onPostReady]);

    const key = rtn?.key ?? ticket;
    const status = rtn?.status ?? "";
    const now = Date.now();
    const url = ticketUrl(site, key);

    return (
        <div data-jira-post-dialog={key} className="flex flex-col">
            <div className="flex items-center gap-3 border-b border-edge-faint px-[18px] py-[15px]">
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <h2 className="text-[15px] font-semibold text-primary">
                        Post progress to <span className="font-mono text-accent-soft">{key}</span>
                    </h2>
                    {rtn != null && moveFailed == null ? (
                        <span data-jira-post-status className="text-[12px] text-ink-mid">
                            Currently {status} in Jira. {lastPostedLine(rtn.lastpost, now)}
                        </span>
                    ) : null}
                </div>
                {moveFailed == null ? (
                    <span className="rounded-[5px] border border-edge-strong px-[7px] py-0.5 font-mono text-[10.5px] text-ink-mid">
                        ctrl+⏎ to post
                    </span>
                ) : null}
            </div>
            {moveFailed != null ? (
                <MoveFailedView failed={moveFailed} url={url} onClose={onClose} />
            ) : loadError != null ? (
                <LoadErrorView error={loadError} onClose={onClose} onConnectJira={onConnectJira} />
            ) : (
                <>
                    <div className="flex flex-col gap-4 px-[18px] py-4">
                        <div className="flex flex-col gap-1.5">
                            <span className="flex items-center gap-2">
                                <span className={LABEL}>Comment</span>
                                {draft?.drafting && !draft.edited ? (
                                    <span data-jira-post-drafting className="text-[11.5px] text-muted">
                                        Drafting summaries…
                                    </span>
                                ) : null}
                            </span>
                            <CommentBox
                                draft={draft}
                                version={version}
                                onChange={(t) => draft && applyDraft(onEdit(draft, t))}
                            />
                            <span className="text-[11.5px] text-muted">
                                Drafted from the plan and the reports of the runs that finished each chunk. Nothing is
                                sent until you post.
                            </span>
                            {draft?.note ? (
                                <span data-jira-post-note className="text-[11.5px] text-ink-mid">
                                    {draft.note}
                                </span>
                            ) : null}
                        </div>
                        {rtn != null ? (
                            <div className="flex flex-col gap-1.5">
                                <span className={LABEL}>Move the ticket</span>
                                <div role="radiogroup" aria-label="Move the ticket" className="flex flex-wrap gap-1.5">
                                    {moveOptions(rtn.transitions).map((m) => (
                                        <button
                                            key={m.id || "leave"}
                                            type="button"
                                            role="radio"
                                            aria-checked={m.id === pick.id}
                                            data-jira-move={m.label}
                                            onClick={() => setPick(m)}
                                            className={cn(
                                                "h-[30px] cursor-pointer rounded-[7px] border px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                                m.id === pick.id
                                                    ? "border-accent bg-accentbg text-accent-soft"
                                                    : "border-edge-strong text-secondary hover:border-edge-mid"
                                            )}
                                        >
                                            {m.label}
                                        </button>
                                    ))}
                                </div>
                                <span className="text-[11.5px] text-muted">
                                    The moves this ticket's workflow allows from {status}.
                                </span>
                            </div>
                        ) : null}
                        {postError != null ? (
                            <motion.div
                                data-jira-post-error
                                variants={viewFade}
                                initial="initial"
                                animate="animate"
                                className="flex items-start gap-2 text-[12.5px] leading-[1.5] text-error-soft"
                            >
                                <CircleAlert size={13} aria-hidden className="mt-[3px] flex-none text-error" />
                                <span>
                                    Couldn't post the comment. {failureLine(postError)}
                                    {postError.kind === "off" && onConnectJira != null ? (
                                        <ConnectJira onClose={onClose} onConnectJira={onConnectJira} />
                                    ) : null}
                                </span>
                            </motion.div>
                        ) : null}
                    </div>
                    <div className="flex items-center gap-2 border-t border-edge-faint px-[18px] py-3">
                        <span data-jira-post-sentence className="text-[12px] text-ink-mid">
                            {rtn != null ? postSentence(status, pick) : ""}
                        </span>
                        <span className="flex-1" />
                        <DialogButton variant="secondary" onClick={onClose}>
                            Cancel
                        </DialogButton>
                        <DialogButton
                            variant="primary"
                            data-jira-post-submit
                            disabled={!canPost}
                            onClick={() => fireAndForget(submit)}
                        >
                            {/* both labels share one grid cell, so the button keeps its width as Posting… */}
                            <span className="grid">
                                <span className={cn("col-start-1 row-start-1", posting && "invisible")}>
                                    {postLabel(pick)}
                                </span>
                                <span className={cn("col-start-1 row-start-1", !posting && "invisible")}>Posting…</span>
                            </span>
                        </DialogButton>
                    </div>
                </>
            )}
        </div>
    );
}

function CommentBox({
    draft,
    version,
    onChange,
}: {
    draft: PostDraft | null;
    version: number;
    onChange: (text: string) => void;
}) {
    const greyed = draft == null || (draft.drafting && !draft.edited);
    return (
        <div className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.textarea
                    key={version}
                    data-jira-post-comment={greyed ? "drafting" : "ready"}
                    aria-label="Comment"
                    variants={textCrossfade}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    value={draft?.text ?? ""}
                    placeholder={draft == null ? "Reading the ticket from Jira…" : undefined}
                    disabled={draft == null}
                    onChange={(e) => onChange(e.target.value)}
                    className={cn(
                        "block h-[250px] w-full resize-none rounded-[7px] border border-edge-strong bg-background px-3 py-2.5 text-[12.5px] leading-[1.6] outline-none focus:border-accent/60",
                        greyed ? "text-muted" : "text-primary"
                    )}
                />
            </AnimatePresence>
        </div>
    );
}

function MoveFailedView({ failed, url, onClose }: { failed: MoveFailed; url: string | null; onClose: () => void }) {
    const lines = moveFailedLines(failed.picked, failed.rtn);
    return (
        <motion.div data-jira-post-result="move-failed" variants={viewFade} initial="initial" animate="animate">
            <div className="flex flex-col gap-3 px-[18px] py-4">
                <span className="flex items-center gap-2 text-[13px] text-ink-hi">
                    <Check size={13} strokeWidth={2.4} aria-hidden className="flex-none text-success" />
                    Comment posted.
                </span>
                <div className="flex flex-col gap-1">
                    <span className="flex items-start gap-2 text-[13px] leading-[1.5] text-ink-hi">
                        <CircleAlert size={13} aria-hidden className="mt-[3px] flex-none text-error" />
                        {lines.failed}
                    </span>
                    <span className="pl-[21px] font-mono text-[11px] text-ink-mid">{lines.jira}</span>
                </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-edge-faint px-[18px] py-3">
                {url != null ? (
                    <DialogButton variant="secondary" onClick={() => getApi().openExternal(url)}>
                        Move it in Jira ↗
                    </DialogButton>
                ) : null}
                <DialogButton variant="primary" onClick={onClose}>
                    Close
                </DialogButton>
            </div>
        </motion.div>
    );
}

function LoadErrorView({
    error,
    onClose,
    onConnectJira,
}: {
    error: JiraFailure;
    onClose: () => void;
    onConnectJira?: () => void;
}) {
    return (
        <motion.div data-jira-post-result="draft-failed" variants={viewFade} initial="initial" animate="animate">
            <div className="flex items-start gap-2 px-[18px] py-4 text-[13px] leading-[1.5] text-ink-hi">
                <CircleAlert size={13} aria-hidden className="mt-[3px] flex-none text-error" />
                <span>
                    Couldn't draft the comment. {failureLine(error)}
                    {error.kind === "off" && onConnectJira != null ? (
                        <ConnectJira onClose={onClose} onConnectJira={onConnectJira} />
                    ) : null}
                </span>
            </div>
            <div className="flex justify-end gap-2 border-t border-edge-faint px-[18px] py-3">
                <DialogButton variant="secondary" onClick={onClose}>
                    Close
                </DialogButton>
            </div>
        </motion.div>
    );
}

function ConnectJira({ onClose, onConnectJira }: { onClose: () => void; onConnectJira: () => void }) {
    return (
        <button
            type="button"
            data-jira-connect
            onClick={() => {
                onClose();
                onConnectJira();
            }}
            className="ml-2 cursor-pointer font-semibold text-accent-soft hover:text-accent"
        >
            Connect Jira
        </button>
    );
}
