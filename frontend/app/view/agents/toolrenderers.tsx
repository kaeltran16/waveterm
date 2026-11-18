// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { viewFade } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { cn } from "@/util/util";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import type { AgentActionEntry, EditFile, ToolImage } from "./agentsviewmodel";
import { capWeighted } from "./bodycap";
import { ImageThumbs, toolZoomImages } from "./imagethumbs";
import { RecordedOutput } from "./recordedoutput";
import { bashCard, toolRendererKey } from "./renderregistry";
import { failureLabel, type TestFailure, type TestSummary } from "./testoutput";
import { BODY_FOOTER, CODE_TEXT, ToolDetailBody } from "./tooldetailbody";

// Tool output cards: a test or diff card is its step's opened body (StepsOpen.dc.html test card), open from the start in
// the rendered view; an image card sits under its row there. A collapsed card (one in a finished turn that is not the
// latest) draws its header only, so history never holds a wall of diff; a click on the header opens it.
// Each Bash card keeps its raw output one toggle away, since a parse can miss what the agent saw.

const CARD = "overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code";
const CARD_HEADER = "flex items-center gap-2.5 border-b border-edge-faint px-3 py-[7px] text-[12.5px]";
const MONO_LABEL = "font-mono text-[10.5px]";
// a failure's message shows at most this many lines (its line-clamp-3), so it costs that much of the body's line cap
const FAILURE_MESSAGE_LINES = 3;

function failureLines(f: TestFailure): number {
    return 1 + (f.message ? Math.min(FAILURE_MESSAGE_LINES, f.message.split("\n").length) : 0);
}

function RawToggle({ raw, onToggle }: { raw: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            data-raw-toggle
            aria-pressed={raw}
            onClick={onToggle}
            className={cn(
                MONO_LABEL,
                "cursor-pointer rounded-[4px] px-1 py-0.5 hover:text-primary",
                raw ? "text-accent-soft" : "text-secondary"
            )}
        >
            raw
        </button>
    );
}

// header (label, counts, raw toggle) over a body that swaps to the raw output. A card whose header says it all (a
// passing run) has no body until raw is on. counts gets whether the body shows, for counts the body otherwise carries.
// footer (the step's "Open full view") sits inside the card's box, under the body, or under the header while collapsed.
function BashCardShell({
    kind,
    label,
    runner,
    counts,
    output,
    collapsed,
    footer,
    children,
}: {
    kind: "test" | "git-diff";
    label: string;
    runner?: string;
    counts: (open: boolean) => ReactNode;
    output: string;
    collapsed?: boolean;
    footer?: ReactNode;
    children?: ReactNode;
}) {
    const [raw, setRaw] = useState(false);
    const [open, setOpen] = useState(!collapsed);
    const body = !open ? null : raw ? <RecordedOutput output={output} /> : children;
    const head = (
        <>
            <span className="font-semibold text-secondary">{label}</span>
            {runner ? <span className={cn(MONO_LABEL, "text-muted")}>{runner}</span> : null}
            <span className="flex-1" />
            {counts(open)}
        </>
    );
    return (
        <div data-tool-card={kind} className={CARD}>
            <div className={cn(CARD_HEADER, body == null && "border-b-0")}>
                {children != null ? (
                    <button
                        type="button"
                        data-card-head
                        aria-expanded={open}
                        onClick={() => setOpen((v) => !v)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
                    >
                        {head}
                    </button>
                ) : (
                    <div data-card-head className="flex min-w-0 flex-1 items-center gap-2.5">
                        {head}
                    </div>
                )}
                {/* raw on a collapsed card opens it to the output */}
                <RawToggle
                    raw={raw}
                    onToggle={() => {
                        setRaw((r) => !r);
                        setOpen(true);
                    }}
                />
            </div>
            {/* a card with no parsed body grows one for raw; one that has a body trades it in place */}
            <PaneReveal open={body != null}>
                <AnimatePresence initial={false} mode="wait">
                    <motion.div
                        key={raw ? "raw" : "parsed"}
                        data-card-view={raw ? "raw" : "parsed"}
                        variants={viewFade}
                        initial="initial"
                        animate="animate"
                    >
                        {body}
                    </motion.div>
                </AnimatePresence>
            </PaneReveal>
            {footer ? <div className={BODY_FOOTER}>{footer}</div> : null}
        </div>
    );
}

function Count({ n, word, tone }: { n: number; word: string; tone: string }) {
    return <span className={n > 0 ? tone : "text-muted"}>{`${n} ${word}`}</span>;
}

function TestCard({
    summary,
    output,
    collapsed,
    footer,
}: {
    summary: TestSummary;
    output: string;
    collapsed?: boolean;
    footer?: ReactNode;
}) {
    const { items: shown, hidden: more } = capWeighted(summary.failures, failureLines);
    const counts = (
        <span data-test-counts className="flex items-center gap-2">
            {summary.unit === "package" ? <span className="text-muted">packages</span> : null}
            <Count n={summary.pass} word="passed" tone="text-success" />
            <Count n={summary.fail} word="failed" tone="text-error" />
            {summary.skip > 0 ? <Count n={summary.skip} word="skipped" tone="text-muted" /> : null}
        </span>
    );
    const rows = shown.map((f, i) => {
        const label = failureLabel(summary.runner, f);
        return (
            <div key={i} data-test-failure className={cn("px-3 py-1.5 font-mono", CODE_TEXT)}>
                {/* the test name takes the width; file:line yields, cut from its left so the line number stays */}
                <div className="flex min-w-0 gap-2.5">
                    <span className="shrink-0 text-error">FAIL</span>
                    <span data-test-name className="min-w-0 flex-1 truncate text-ink-hi" title={label.name}>
                        {label.name}
                    </span>
                    {label.where ? (
                        <span
                            data-test-where
                            dir="rtl"
                            className="min-w-0 max-w-[40%] truncate text-left text-muted"
                            title={label.whereFull}
                        >
                            <bdi dir="ltr">{label.where}</bdi>
                        </span>
                    ) : null}
                </div>
                {f.message ? (
                    // hangs under the name: past FAIL's four characters and the gap
                    <div className="mt-[3px] line-clamp-3 whitespace-pre-wrap break-words pl-[calc(4ch+10px)] text-secondary">
                        {f.message}
                    </div>
                ) : null}
            </div>
        );
    });
    return (
        <BashCardShell
            kind="test"
            label="Tests"
            runner={summary.runner === "go" ? "go test" : "vitest"}
            counts={() => counts}
            output={output}
            collapsed={collapsed}
            footer={footer}
        >
            {rows.length > 0 ? (
                <>
                    {rows}
                    {more > 0 ? (
                        <div data-more-lines className="px-3 py-1.5 text-[12px] text-muted">
                            {`${more} more ${more === 1 ? "failure" : "failures"}`}
                        </div>
                    ) : null}
                </>
            ) : undefined}
        </BashCardShell>
    );
}

function DiffCard({
    files,
    output,
    collapsed,
    footer,
}: {
    files: EditFile[];
    output: string;
    collapsed?: boolean;
    footer?: ReactNode;
}) {
    const adds = files.reduce((n, f) => n + f.adds, 0);
    const dels = files.reduce((n, f) => n + f.dels, 0);
    // an open card's one file row already carries its counts
    const counts = (open: boolean) => (
        <span className="flex items-center gap-2">
            <span
                className={cn(MONO_LABEL, "text-muted")}
            >{`${files.length} file${files.length === 1 ? "" : "s"}`}</span>
            {files.length > 1 || !open ? (
                <>
                    <span className={cn(MONO_LABEL, adds > 0 ? "font-bold text-diff-added" : "text-muted")}>
                        +{adds}
                    </span>
                    <span className={cn(MONO_LABEL, dels > 0 ? "font-bold text-diff-removed" : "text-muted")}>
                        −{dels}
                    </span>
                </>
            ) : null}
        </span>
    );
    return (
        <BashCardShell
            kind="git-diff"
            label="git diff"
            counts={counts}
            output={output}
            collapsed={collapsed}
            footer={footer}
        >
            <ToolDetailBody detail={{ kind: "edit", files }} variant="inline" capped />
        </BashCardShell>
    );
}

function ImageCard({ images }: { images: ToolImage[] }) {
    return (
        // fits its thumbnails: a column-wide frame around one small image is mostly empty
        <div data-tool-card="image" className={cn(CARD, "flex w-fit max-w-full flex-col gap-2 p-2")}>
            <ImageThumbs images={toolZoomImages(images)} />
        </div>
    );
}

// collapsed: a test or diff card draws its header only until clicked; an image card is already small, so it ignores it.
// footer: drawn inside a test or diff card's box, under its body
export function ToolOutputRenderer({
    action,
    collapsed,
    footer,
}: {
    action: AgentActionEntry;
    collapsed?: boolean;
    footer?: ReactNode;
}) {
    const key = toolRendererKey(action);
    if (key === "image") {
        return <ImageCard images={action.images} />;
    }
    const card = bashCard(action.detail);
    const output = action.detail?.kind === "bash" ? action.detail.output : "";
    if (card?.key === "test") {
        return <TestCard summary={card.summary} output={output} collapsed={collapsed} footer={footer} />;
    }
    if (card?.key === "git-diff") {
        return <DiffCard files={card.files} output={output} collapsed={collapsed} footer={footer} />;
    }
    return null;
}
