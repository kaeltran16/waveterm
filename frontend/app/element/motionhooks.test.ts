// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from "vitest";
import { useDidBecomeTrue, useSettle } from "./motionhooks";

// @testing-library/react is not a dependency of this repo, so useSettle (a React hook needing a
// renderer) has no unit harness here. It is lifted verbatim from channelssurface.tsx's proven
// useSettle; behavior is covered by the Task 5 CDP visual check (hunk/file completion settle).
// See docs/superpowers/plans/2026-07-04-files-diff-motion-system.md Task 3, Step 1.
describe.skip("useSettle (no @testing-library/react — covered by CDP visual check)", () => {
    test("one-shot on false→true then clears", () => {
        void useSettle;
    });
});

// useDidBecomeTrue is a React hook; no @testing-library/react in this repo, so no unit harness.
// Behavior (fires once on false→true, suppressed when mounted already-true) is covered by the
// Task 4 CDP visual check (Historical load reveal). See usage-motion-design.md.
describe.skip("useDidBecomeTrue (no @testing-library/react — covered by CDP visual check)", () => {
    test("fires once on false→true, suppressed when mounted already-true", () => {
        void useDidBecomeTrue;
    });
});
