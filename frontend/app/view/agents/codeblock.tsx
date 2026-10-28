// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCopyFeedback, type CopyState } from "@/app/element/copyfeedback";
import { CrossFade } from "@/app/element/crossfade";
import { highlightLine } from "./highlight";

// Styled fenced-code block for transcript prose (Wave-transcript-feed.dc.html code block).
// lang label + optional path + copy affordance + line-number gutter + tokenized source.
export function CodeBlock({ code, lang, path }: { code: string; lang?: string; path?: string }) {
    const { state, copy } = useCopyFeedback();
    const lines = code.replace(/\n$/, "").split("\n");
    return (
        <div className="my-1.5 overflow-hidden rounded-[10px] border border-border bg-surface-code">
            <div
                data-code-head
                className="flex select-none items-center gap-2 border-b border-edge-faint bg-surface px-[11px] py-[7px]"
            >
                {lang ? (
                    <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-accent">
                        {lang}
                    </span>
                ) : null}
                {path ? <span className="font-mono text-[10.5px] text-muted">{path}</span> : null}
                <div className="flex-1" />
                <button type="button" onClick={() => copy(code)} className={cnCopy(state)}>
                    <CrossFade swapKey={state}>{COPY_LABEL[state]}</CrossFade>
                </button>
            </div>
            <div className="overflow-x-auto">
                <div className="min-w-min py-[9px]">
                    {lines.map((ln, i) => (
                        <div key={i} className="flex whitespace-pre font-mono text-[12px] leading-[1.75]">
                            <span className="w-[34px] shrink-0 select-none pr-[14px] text-right text-ink-faint">
                                {i + 1}
                            </span>
                            <span className="pr-4">
                                {highlightLine(ln).map((tk, k) => (
                                    <span key={k} className={tk.cls}>
                                        {tk.t}
                                    </span>
                                ))}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

const COPY_LABEL: Record<CopyState, string> = { idle: "Copy", copied: "Copied", failed: "Copy failed" };
const COPY_TONE: Record<CopyState, string> = { idle: "text-muted", copied: "text-success", failed: "text-error" };

function cnCopy(state: CopyState): string {
    return (
        "flex items-center gap-[5px] rounded-sm border border-edge-mid px-2 py-[3px] font-mono " +
        "text-[10.5px] tracking-[0.03em] hover:border-edge-strong " +
        COPY_TONE[state]
    );
}
