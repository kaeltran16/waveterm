// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { openLink } from "@/app/store/global";
import { cn } from "@/util/util";
import { Lightbulb } from "lucide-react";
import { createContext, Fragment, memo, useContext, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./codeblock";
import { splitInsightBlocks } from "./insightblocks";
import { FILE_LINE_PROP, FILE_PATH_PROP, remarkFileLinks, type ReplyFileLink } from "./replyfilelinks";
import { blockRendererFor } from "./renderregistry";
import { remarkSoftBreaks } from "./softbreaks";

// Lightweight inline markdown for narration lines. Deliberately NOT the full element/markdown.tsx
// (which wraps every render in OverlayScrollbars + a TOC + rehypeRaw); raw HTML is not enabled here,
// so transcript text cannot inject markup.

// a host that opens a file path in a reply sets this; without one a path stays text
export const FileLinkContext = createContext<((link: ReplyFileLink) => void) | null>(null);

// A file path in a reply: a span, not an anchor, so a drag across it selects the text around it and copies the whole
// path even where it ellipsizes. A click that ends a selection selects; it does not open.
function FileLink({ path, line, children }: { path: string; line: number | null; children: ReactNode }) {
    const open = useContext(FileLinkContext);
    const activate = () => open?.({ path, line });
    return (
        <span
            role="link"
            tabIndex={0}
            data-file-link={path}
            title={line != null ? `${path}:${line}` : path}
            onClick={() => {
                if (window.getSelection()?.isCollapsed !== false) {
                    activate();
                }
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    activate();
                }
            }}
            className="inline-block max-w-full cursor-pointer truncate align-bottom text-accent hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
            {children}
        </span>
    );
}

// a table cell with at most this much text stays on one line; a longer one wraps, but no narrower than
// CELL_MIN_WIDTH, so a narrow host scrolls the table instead of squeezing a column to a word per line
const CELL_NOWRAP_MAX_CHARS = 16;
const CELL_MIN_WIDTH = "20ch";
// an inline code word up to this long never breaks inside ("--flag", "a/b.go:12"); a longer one wraps
const CODE_NOWRAP_MAX_CHARS = 32;

type HastNode = { type: string; value?: string; tagName?: string; children?: HastNode[] };

function hastText(node: HastNode | undefined): string {
    if (node == null) return "";
    if (node.type === "text") return node.value ?? "";
    return (node.children ?? []).map(hastText).join("");
}

// style carries a GFM column's alignment
function cellProps(node: HastNode | undefined, style: CSSProperties | undefined) {
    return hastText(node).length > CELL_NOWRAP_MAX_CHARS
        ? { style: { ...style, minWidth: CELL_MIN_WIDTH } }
        : { style, className: "whitespace-nowrap" };
}

// an outside marker hangs in the list's left margin: the margin grows by a digit's width per digit past the first,
// so "10." and "100." show whole
function olDigits(node: HastNode | undefined, start: number | undefined): number {
    const items = (node?.children ?? []).filter((c) => c.tagName === "li").length;
    const first = start ?? 1;
    return String(Math.max(Math.abs(first), Math.abs(first + items - 1))).length;
}

function codeWords(text: string): ReactNode[] {
    return text.split(/(\s+)/).map((w, i) =>
        w.length > 0 && w.length <= CODE_NOWRAP_MAX_CHARS && !/\s/.test(w) ? (
            <span key={i} className="whitespace-nowrap">
                {w}
            </span>
        ) : (
            w
        )
    );
}

// links open through the app helper (external/internal routing), matching element/markdown.tsx —
// NOT target=_blank, which bypasses that routing. tables are wrapped so wide ones scroll inside
// the panel instead of breaking its width. A file link (replyfilelinks.ts) draws as a FileLink.
const MD_COMPONENTS: Components = {
    a: ({ node, href, children }) => {
        const path = node?.properties?.[FILE_PATH_PROP];
        if (typeof path === "string") {
            const line = node.properties[FILE_LINE_PROP];
            return (
                <FileLink path={path} line={typeof line === "number" ? line : null}>
                    {children}
                </FileLink>
            );
        }
        return (
            <a
                href={href}
                onClick={(e) => {
                    e.preventDefault();
                    openLink(href);
                }}
                className="cursor-pointer text-accent hover:underline"
            >
                {children}
            </a>
        );
    },
    table: ({ children }) => (
        <div className="agent-table-wrap">
            <table>{children}</table>
        </div>
    ),
    th: ({ node, children, style }) => <th {...cellProps(node, style)}>{children}</th>,
    td: ({ node, children, style }) => <td {...cellProps(node, style)}>{children}</td>,
    ol: ({ node, children, start, className }) => {
        const digits = olDigits(node, start);
        return (
            <ol
                start={start}
                className={className}
                style={digits > 1 ? ({ "--ol-digits": digits } as CSSProperties) : undefined}
            >
                {children}
            </ol>
        );
    },
    // a fenced block's code is read by pre below, so this draws inline code only
    code: ({ className, children }) => (
        <code className={className}>{typeof children === "string" ? codeWords(children) : children}</code>
    ),
    pre: ({ children }) => {
        // children is the <code> element react-markdown produced for a fenced block
        const child: any = Array.isArray(children) ? children[0] : children;
        const props = child?.props ?? {};
        const className: string = props.className ?? "";
        const lang = /language-(\w+)/.exec(className)?.[1];
        const raw = Array.isArray(props.children) ? props.children.join("") : String(props.children ?? "");
        const Renderer = blockRendererFor(lang);
        return Renderer ? <Renderer raw={raw} /> : <CodeBlock code={raw} lang={lang} />;
    },
};

// soft breaks before file links, so a path is matched within its own line
function remarkPlugins(fileLinks: boolean, breaks: boolean) {
    return [remarkGfm, ...(breaks ? [remarkSoftBreaks] : []), ...(fileLinks ? [remarkFileLinks] : [])];
}

function renderMd(text: string, fileLinks: boolean, breaks: boolean) {
    return (
        <ReactMarkdown remarkPlugins={remarkPlugins(fileLinks, breaks)} components={MD_COMPONENTS}>
            {text}
        </ReactMarkdown>
    );
}

function InsightCallout({ text, fileLinks, breaks }: { text: string; fileLinks: boolean; breaks: boolean }) {
    return (
        <div data-insight className="my-2.5 rounded-[8px] border border-accent/25 bg-accent/[0.05] px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-accent-soft">
                <Lightbulb size={11} strokeWidth={2.2} aria-hidden />
                Insight
            </div>
            {renderMd(text, fileLinks, breaks)}
        </div>
    );
}

// breaks: a single newline draws as a line break, as in an agent's terminal; off for hard-wrapped documents
export const MarkdownMessage = memo(function MarkdownMessage({
    text,
    className,
    breaks = false,
}: {
    text: string;
    className?: string;
    breaks?: boolean;
}) {
    const segments = splitInsightBlocks(text);
    const fileLinks = useContext(FileLinkContext) != null;
    return (
        <div className={cn("agent-md", className)}>
            {segments.map((seg, i) =>
                seg.kind === "insight" ? (
                    <InsightCallout key={i} text={seg.text} fileLinks={fileLinks} breaks={breaks} />
                ) : (
                    <Fragment key={i}>{renderMd(seg.text, fileLinks, breaks)}</Fragment>
                )
            )}
        </div>
    );
});
