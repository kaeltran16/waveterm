// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isTopModal, ownsFocus, popId, pushId, registerModal, topId } from "./modalstack";

describe("modalstack", () => {
    it("the last opened modal is the topmost", () => {
        const stack = pushId(pushId([], "peek"), "confirm");
        expect(topId(stack)).toBe("confirm");
    });

    it("an empty stack has no top", () => {
        expect(topId([])).toBe(null);
    });

    it("closing the top hands the keyboard back to the one beneath it", () => {
        const stack = pushId(pushId([], "peek"), "confirm");
        expect(topId(popId(stack, "confirm"))).toBe("peek");
    });

    it("closing out of order leaves the rest of the order intact", () => {
        const stack = pushId(pushId(pushId([], "a"), "b"), "c");
        expect(popId(stack, "b")).toEqual(["a", "c"]);
        expect(topId(popId(stack, "b"))).toBe("c");
    });

    it("registering twice does not double-enter (a re-run effect must not stack an id on itself)", () => {
        expect(pushId(pushId([], "a"), "a")).toEqual(["a"]);
    });

    it("popping something absent is a no-op", () => {
        expect(popId(["a"], "ghost")).toEqual(["a"]);
    });

    it("hands the keyboard back to a peek once the confirm stacked over it closes", () => {
        const closePeek = registerModal("peek");
        const closeConfirm = registerModal("confirm");
        expect(isTopModal("confirm")).toBe(true);
        expect(isTopModal("peek")).toBe(false);
        closeConfirm();
        expect(isTopModal("peek")).toBe(true);
        closePeek();
    });

    it("lets only the topmost shell move focus", () => {
        expect(ownsFocus(["peek", "confirm"], "confirm")).toBe(true);
        // a shell under another must neither take focus on open nor restore it on close: either would pull focus out
        // of the dialog the user is looking at
        expect(ownsFocus(["peek", "confirm"], "peek")).toBe(false);
        expect(ownsFocus([], "peek")).toBe(false);
    });
});
