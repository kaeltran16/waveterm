// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    HISTORY_PAGE_SIZE,
    NO_FILTERS,
    RESTORE_THRESHOLD_MS,
    activeFilterCount,
    anyFilterActive,
    countLabel,
    filterSummary,
    hasMorePages,
    restoreNotice,
    toHistoryQuery,
} from "./historyquery";

describe("activeFilterCount / anyFilterActive", () => {
    it("counts only non-blank fields", () => {
        expect(activeFilterCount(NO_FILTERS)).toBe(0);
        expect(anyFilterActive(NO_FILTERS)).toBe(false);
        expect(activeFilterCount({ author: "dana", path: "", text: "" })).toBe(1);
        expect(activeFilterCount({ author: "dana", path: "src/**", text: "refund" })).toBe(3);
    });

    it("treats whitespace as blank, so a stray space does not read as a filter", () => {
        expect(activeFilterCount({ author: "   ", path: "", text: "" })).toBe(0);
        expect(anyFilterActive({ author: "   ", path: "", text: "" })).toBe(false);
    });
});

describe("toHistoryQuery", () => {
    it("omits blank fields rather than sending empty strings", () => {
        expect(toHistoryQuery(NO_FILTERS)).toEqual({});
        expect(toHistoryQuery({ author: "dana", path: "", text: "" })).toEqual({ author: "dana" });
    });

    it("maps free text onto grep and trims every field", () => {
        expect(toHistoryQuery({ author: " dana ", path: " src/** ", text: " refund " })).toEqual({
            author: "dana",
            path: "src/**",
            grep: "refund",
        });
    });
});

describe("filterSummary", () => {
    it("counts filters and matches, singular and plural", () => {
        expect(filterSummary({ author: "dana", path: "src/**", text: "" }, 4)).toBe("2 filters · 4 matching commits");
        expect(filterSummary({ author: "dana", path: "", text: "" }, 1)).toBe("1 filter · 1 matching commit");
    });

    it("is null when nothing is filtered, so the row shows no count chip", () => {
        expect(filterSummary(NO_FILTERS, 12)).toBeNull();
    });
});

describe("countLabel", () => {
    it("reports what is loaded, never a repository total the surface has not counted", () => {
        expect(countLabel(NO_FILTERS, 50, false)).toBe("50 commits loaded");
        expect(countLabel(NO_FILTERS, 1, false)).toBe("1 commit loaded");
        expect(countLabel({ author: "dana", path: "", text: "" }, 4, false)).toBe("4 matching commits");
        expect(countLabel(NO_FILTERS, 0, true)).toBe("");
    });
});

describe("hasMorePages", () => {
    it("assumes more only when the page came back full", () => {
        expect(hasMorePages(HISTORY_PAGE_SIZE)).toBe(true);
        expect(hasMorePages(HISTORY_PAGE_SIZE - 1)).toBe(false);
        expect(hasMorePages(0)).toBe(false);
    });
});

describe("restoreNotice", () => {
    const away = RESTORE_THRESHOLD_MS + 1;

    it("stays silent for a quick flip away and back, however much was restored", () => {
        expect(
            restoreNotice({
                awayMs: RESTORE_THRESHOLD_MS - 1,
                commit: "c41d8ecafe",
                scroll: 420,
                filters: { author: "dana", path: "", text: "" },
                topRowHash: "aaaaaaa",
            })
        ).toBeNull();
    });

    it("stays silent when nothing but the default came back", () => {
        expect(
            restoreNotice({ awayMs: away, commit: "aaaaaaa", scroll: 0, filters: NO_FILTERS, topRowHash: "aaaaaaa" })
        ).toBeNull();
    });

    it("names the short hash, the scroll offset and the filter count", () => {
        expect(
            restoreNotice({
                awayMs: away,
                commit: "c41d8ecafe0011",
                scroll: 420,
                filters: { author: "dana", path: "src/**", text: "" },
                topRowHash: "aaaaaaa",
            })
        ).toBe("Commit c41d8ec, history scroll offset and 2 filters came back with the surface.");
    });

    it("uses the singular for one filter and no list separator for a single item", () => {
        expect(
            restoreNotice({
                awayMs: away,
                commit: null,
                scroll: 0,
                filters: { author: "dana", path: "", text: "" },
                topRowHash: "aaa",
            })
        ).toBe("1 filter came back with the surface.");
    });

    // the working-tree row's hash is "" and it is the default selection on a dirty tree, so it must
    // never count as "you were somewhere unusual"
    it("does not count the uncommitted row as a restored selection", () => {
        expect(restoreNotice({ awayMs: away, commit: "", scroll: 0, filters: NO_FILTERS, topRowHash: "" })).toBeNull();
    });
});
