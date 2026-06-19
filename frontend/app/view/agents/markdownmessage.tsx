// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Lightweight inline markdown for narration lines. Deliberately NOT the full element/markdown.tsx
// (which wraps every render in OverlayScrollbars + a TOC + rehypeRaw); raw HTML is not enabled here,
// so transcript text cannot inject markup.
export function MarkdownMessage({ text, className }: { text: string; className?: string }) {
    return (
        <div className={cn("agent-md", className)}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
    );
}
