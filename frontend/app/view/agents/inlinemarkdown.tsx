// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { openLink } from "@/app/store/global";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export function condenseToLine(text: string): string {
    const firstPara = text.split(/\n\s*\n/)[0] ?? "";
    return firstPara
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*>\s+/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
}

const INLINE_ALLOWED = ["a", "strong", "em", "code", "del"];

const INLINE_COMPONENTS: Components = {
    a: ({ href, children }) => (
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
    ),
    code: ({ children }) => <code className="font-mono text-accent-soft">{children}</code>,
};

export function InlineMarkdown({ text }: { text: string }) {
    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={INLINE_ALLOWED} unwrapDisallowed components={INLINE_COMPONENTS}>
            {condenseToLine(text)}
        </ReactMarkdown>
    );
}