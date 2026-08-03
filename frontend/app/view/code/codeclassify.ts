// frontend/app/view/code/codeclassify.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: decide how an opened file should be presented, from its stat and (as a backstop) its
// decoded content. Keeps the size and binary gates out of the store's IO path.

export const MAX_VIEW_BYTES = 2 * 1024 * 1024;

// application/* types that are really text. Anything else outside text/* is binary.
const TEXTISH_MIME = new Set([
    "application/json",
    "application/javascript",
    "application/xml",
    "application/x-sh",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
]);

export type FileClass = "text" | "binary" | "toolarge";

// an empty mimetype means the backend did not recognize the extension — Go, Rust and most config
// files land there, so empty must be viewable or the surface would call this repo binary.
export function classifyFile(size: number, mimeType: string): FileClass {
    if (size > MAX_VIEW_BYTES) {
        return "toolarge";
    }
    const m = (mimeType ?? "").split(";")[0].trim().toLowerCase();
    if (m === "" || m.startsWith("text/") || TEXTISH_MIME.has(m)) {
        return "text";
    }
    return "binary";
}

const NUL_SCAN_CHARS = 8192;

// backstop for a wrong or absent mimetype: real source text contains no NUL.
export function hasNulByte(text: string): boolean {
    return text.slice(0, NUL_SCAN_CHARS).includes("\u0000");
}
