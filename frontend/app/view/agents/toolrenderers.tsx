// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState, type ReactNode } from "react";
import type { AgentActionEntry, EditFile, ToolImage } from "./agentsviewmodel";
import { ToolDetailBody } from "./narrationtimeline";
import { bashCard, toolRendererKey } from "./renderregistry";
import { failureLabel, stripAnsi, type TestSummary } from "./testoutput";
import { capDiffLines } from "./unifieddiff";

// Tool output cards, drawn open under their tool row in the rendered view (Main.dc.html go-test card).
// Each Bash card keeps its raw output one toggle away, since a parse can miss what the agent saw.

const CARD = "overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code";
const CARD_HEADER = "flex items-center gap-2 border-b border-edge-faint px-[11px] py-[7px]";
const MONO_LABEL = "font-mono text-[10.5px]";
// a card never grows past this; its body scrolls
const CARD_BODY = "max-h-[360px] overflow-auto";
// a 15k-line diff would build as many DOM rows; the rest is in raw
const DIFF_LINES_SHOWN_MAX = 400;
const FAILURES_SHOWN_MAX = 100;

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

function RawOutput({ output }: { output: string }) {
    return (
        <pre className="m-0 whitespace-pre-wrap px-[11px] py-[9px] font-mono text-[11.5px] leading-[1.7] text-ink-mid [overflow-wrap:anywhere]">
            {stripAnsi(output)}
        </pre>
    );
}

// header (label, counts, raw toggle) over a body that swaps to the raw output. A card whose header says it all (a
// passing run) has no body until raw is on.
function BashCardShell({
    kind,
    label,
    counts,
    output,
    children,
}: {
    kind: "test" | "git-diff";
    label: string;
    counts: ReactNode;
    output: string;
    children?: ReactNode;
}) {
    const [raw, setRaw] = useState(false);
    const body = raw ? <RawOutput output={output} /> : children;
    return (
        <div data-tool-card={kind} className={CARD}>
            <div className={cn(CARD_HEADER, body == null && "border-b-0")}>
                <span className={cn(MONO_LABEL, "text-accent-soft")}>{label}</span>
                <span className="flex-1" />
                {counts}
                <RawToggle raw={raw} onToggle={() => setRaw((r) => !r)} />
            </div>
            {body != null ? <div className={CARD_BODY}>{body}</div> : null}
        </div>
    );
}

function Count({ n, word, tone }: { n: number; word: string; tone: string }) {
    return <span className={cn(MONO_LABEL, n > 0 ? tone : "text-muted")}>{`${n} ${word}`}</span>;
}

function TestCard({ summary, output }: { summary: TestSummary; output: string }) {
    const shown = summary.failures.slice(0, FAILURES_SHOWN_MAX);
    const more = summary.failures.length - shown.length;
    const counts = (
        <span data-test-counts className="flex items-center gap-2">
            {summary.unit === "package" ? <span className={cn(MONO_LABEL, "text-muted")}>packages</span> : null}
            <Count n={summary.pass} word="pass" tone="text-success" />
            <Count n={summary.fail} word="fail" tone="text-error" />
            <Count n={summary.skip} word="skip" tone="text-muted" />
        </span>
    );
    const rows = shown.map((f, i) => {
        const label = failureLabel(summary.runner, f);
        return (
            <div
                key={i}
                data-test-failure
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 border-b border-edge-faint px-[11px] py-[7px] font-mono text-[11.5px] last:border-b-0"
            >
                <span className="text-error">FAIL</span>
                <span className="truncate text-ink-hi" title={label.name}>
                    {label.name}
                </span>
                <span className="text-muted" title={label.whereFull}>
                    {label.where ?? ""}
                </span>
                {f.message ? (
                    <span className="col-span-2 col-start-2 line-clamp-3 whitespace-pre-wrap text-secondary [overflow-wrap:anywhere]">
                        {f.message}
                    </span>
                ) : null}
            </div>
        );
    });
    return (
        <BashCardShell
            kind="test"
            label={summary.runner === "go" ? "go test" : "vitest"}
            counts={counts}
            output={output}
        >
            {rows.length > 0 ? (
                <>
                    {rows}
                    {more > 0 ? (
                        <div className="px-[11px] py-[7px] text-[12px] text-muted">{`${more} more failures in raw`}</div>
                    ) : null}
                </>
            ) : undefined}
        </BashCardShell>
    );
}

function DiffCard({ files, output }: { files: EditFile[]; output: string }) {
    const { files: shown, hidden } = capDiffLines(files, DIFF_LINES_SHOWN_MAX);
    const adds = files.reduce((n, f) => n + f.adds, 0);
    const dels = files.reduce((n, f) => n + f.dels, 0);
    // one file's row already carries its counts
    const counts = (
        <span className="flex items-center gap-2">
            <span
                className={cn(MONO_LABEL, "text-muted")}
            >{`${files.length} file${files.length === 1 ? "" : "s"}`}</span>
            {files.length > 1 ? (
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
        <BashCardShell kind="git-diff" label="git diff" counts={counts} output={output}>
            <ToolDetailBody detail={{ kind: "edit", files: shown }} variant="inline" />
            {hidden > 0 ? (
                <div className="px-[11px] py-[7px] text-[12px] text-muted">{`${hidden} more lines in raw`}</div>
            ) : null}
        </BashCardShell>
    );
}

function ImageCard({ images }: { images: ToolImage[] }) {
    return (
        <div data-tool-card="image" className={cn(CARD, "flex flex-col gap-2 p-2")}>
            {images.map((img, i) => (
                <img
                    key={i}
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={`image output ${i + 1}`}
                    className="max-h-[360px] max-w-full self-start object-contain"
                />
            ))}
        </div>
    );
}

export function ToolOutputRenderer({ action }: { action: AgentActionEntry }) {
    const key = toolRendererKey(action);
    if (key === "image") {
        return <ImageCard images={action.images} />;
    }
    const card = bashCard(action.detail);
    const output = action.detail?.kind === "bash" ? action.detail.output : "";
    if (card?.key === "test") {
        return <TestCard summary={card.summary} output={output} />;
    }
    if (card?.key === "git-diff") {
        return <DiffCard files={card.files} output={output} />;
    }
    return null;
}
