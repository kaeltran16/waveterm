// frontend/app/view/code/codeclassify.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { classifyFile, hasNulByte, MAX_VIEW_BYTES } from "./codeclassify";

describe("classifyFile", () => {
    it("treats an unrecognized (empty) mimetype as text, because Go and Rust land there", () => {
        expect(classifyFile(1000, "")).toBe("text");
    });

    it("accepts any text/* type", () => {
        expect(classifyFile(1000, "text/x-python")).toBe("text");
    });

    it("accepts the application/* types that are really text", () => {
        expect(classifyFile(1000, "application/json")).toBe("text");
        expect(classifyFile(1000, "application/javascript")).toBe("text");
    });

    it("ignores a charset parameter on the mimetype", () => {
        expect(classifyFile(1000, "text/plain; charset=utf-8")).toBe("text");
    });

    it("calls a real binary type binary", () => {
        expect(classifyFile(1000, "image/png")).toBe("binary");
        expect(classifyFile(1000, "application/octet-stream")).toBe("binary");
    });

    it("lets the size gate win over a text mimetype", () => {
        expect(classifyFile(MAX_VIEW_BYTES + 1, "text/plain")).toBe("toolarge");
    });

    it("admits a file exactly at the cap", () => {
        expect(classifyFile(MAX_VIEW_BYTES, "text/plain")).toBe("text");
    });
});

describe("hasNulByte", () => {
    it("is false for ordinary source text", () => {
        expect(hasNulByte("package main\n\nfunc main() {}\n")).toBe(false);
    });

    it("is true when a NUL appears in the scanned head", () => {
        expect(hasNulByte("abc\u0000def")).toBe(true);
    });

    it("does not scan past the head window", () => {
        expect(hasNulByte("a".repeat(9000) + "\u0000")).toBe(false);
    });
});
