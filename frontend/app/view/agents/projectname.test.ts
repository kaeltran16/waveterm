// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { projectNameFromTranscriptPath } from "./projectname";

describe("projectNameFromTranscriptPath", () => {
    it("derives the repo name from the encoded cwd dir", () => {
        const p = "/home/u/.claude/projects/C--Users-kael02-IdeaProjects-waveterm/abc.jsonl";
        expect(projectNameFromTranscriptPath(p)).toBe("waveterm");
    });
    it("handles backslash paths", () => {
        const p = "C:\\Users\\u\\.claude\\projects\\C--Users-kael02-IdeaProjects-cyber_anomaly_detector\\x.jsonl";
        expect(projectNameFromTranscriptPath(p)).toBe("cyber_anomaly_detector");
    });
    it("returns empty for paths without a projects segment", () => {
        expect(projectNameFromTranscriptPath("/tmp/foo.jsonl")).toBe("");
        expect(projectNameFromTranscriptPath("")).toBe("");
    });
});
