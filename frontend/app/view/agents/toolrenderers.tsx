// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { viewFade } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { cn } from "@/util/util";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import type { AgentActionEntry, EditFile, ToolImage } from "./agentsviewmodel";
import { capFailures, capText, FAILURE_MESSAGE_LINES, moreFailuresLabel } from "./bodycap";
import { ImageThumbs, toolZoomImages } from "./imagethumbs";
import { RecordedOutput } from "./recordedoutput";
import { bashCard, toolRendererKey } from "./renderregistry";
import { failureLabel, type TestSummary } from "./testoutput";
import { CODE_TEXT, MoreLines, ToolDetailBody } from "./tooldetailbody";

// Tool output cards: a test or diff card is its step's opened body (StepsOpen.dc.html test card), open from the start in
// the rendered view; an image card sits under its row there. A collapsed card (one in a finished turn that is not the
// latest) draws its header only, so history never holds a wall of diff; a click on the header opens it.
// Each Bash card keeps its raw output one toggle away, since a parse can miss what the agent saw.

const CARD = "overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code";
const CARD_HEADER = "flex items-center gap-2.5 border-b border-edge-faint px-3 py-[7px] text-[12.5px]";
const MONO_LABEL = "font-mono text-[10.5px]";

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
function BashCardShell({
    kind,
    label,
    runner,
    counts,
    output,
    collapsed,
    children,
}: {
    kind: "test" | "git-diff";
    label: string;
    runner?: string;
    counts: (open: boolean) => ReactNode;
    output: string;
    collapsed?: boolean;
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
        </div>
    );
}

function Count({ n, word, tone }: { n: number; word: string; tone: string }) {
    return <span className={n > 0 ? tone : "text-muted"}>{`${n} ${word}`}</span>;
}

// collapsed, each failure's message is clamped to whole lines and the failures cut to the body's cap; expanded, every
// failure shows with its whole message
function TestCard({ summary, output, collapsed }: { summary: TestSummary; output: string; collapsed?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const cut = capFailures(summary.failures);
    const shown = expanded ? summary.failures : cut.failures;
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
                    <div
                        data-test-message
                        className="mt-[3px] whitespace-pre-wrap break-words pl-[calc(4ch+10px)] text-secondary"
                    >
                        {expanded ? f.message : capText(f.message, FAILURE_MESSAGE_LINES).text}
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
        >
            {rows.length > 0 ? (
                <>
                    {rows}
                    <MoreLines
                        hidden={cut.hidden}
                        label={moreFailuresLabel(cut)}
                        expanded={expanded}
                        onToggle={() => setExpanded((v) => !v)}
                        className="px-3 py-1.5"
                    />
                </>
            ) : undefined}
        </BashCardShell>
    );
}

function DiffCard({ files, output, collapsed }: { files: EditFile[]; output: string; collapsed?: boolean }) {
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
        <BashCardShell kind="git-diff" label="git diff" counts={counts} output={output} collapsed={collapsed}>
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
export function ToolOutputRenderer({ action, collapsed }: { action: AgentActionEntry; collapsed?: boolean }) {
    const key = toolRendererKey(action);
    if (key === "image") {
        return <ImageCard images={action.images} />;
    }
    const card = bashCard(action.detail);
    const output = action.detail?.kind === "bash" ? action.detail.output : "";
    if (card?.key === "test") {
        return <TestCard summary={card.summary} output={output} collapsed={collapsed} />;
    }
    if (card?.key === "git-diff") {
        return <DiffCard files={card.files} output={output} collapsed={collapsed} />;
    }
    return null;
}
