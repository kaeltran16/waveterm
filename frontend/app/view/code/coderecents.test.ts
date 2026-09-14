// frontend/app/view/code/coderecents.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MAX_RECENTS, pickerRecents, pruneRecent, pushRecent } from "./coderecents";

const alpha = { name: "alpha", path: "C:\\repos\\alpha" };
const beta = { name: "beta", path: "C:\\repos\\beta" };

describe("pushRecent", () => {
    it("puts the selection first", () => {
        expect(pushRecent([alpha], beta)).toEqual([beta, alpha]);
    });

    it("moves a known path to the front instead of listing it twice, whatever its spelling", () => {
        const respelled = { name: "alpha", path: "c:/repos/ALPHA" };
        expect(pushRecent([beta, alpha], respelled)).toEqual([respelled, beta]);
    });

    it("drops the oldest entry past the cap", () => {
        const full = Array.from({ length: MAX_RECENTS }, (_, i) => ({ name: `p${i}`, path: `C:\\p${i}` }));
        const next = pushRecent(full, alpha);
        expect(next).toHaveLength(MAX_RECENTS);
        expect(next[0]).toEqual(alpha);
        expect(next).not.toContainEqual(full[MAX_RECENTS - 1]);
    });
});

describe("pruneRecent", () => {
    it("removes the entry for a path, whatever its spelling", () => {
        expect(pruneRecent([alpha, beta], "c:/repos/alpha")).toEqual([beta]);
    });
});

describe("pickerRecents", () => {
    it("leaves out paths the picker already lists in another section", () => {
        expect(pickerRecents([alpha, beta], ["C:/repos/beta"])).toEqual([alpha]);
    });
});
