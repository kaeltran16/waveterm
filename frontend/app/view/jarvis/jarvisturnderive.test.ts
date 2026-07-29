import { describe, expect, it } from "vitest";
import { terminalBadge } from "./jarvisturnderive";

describe("terminalBadge", () => {
    it("gives no badge for a normal answered turn", () => {
        expect(terminalBadge("answered")).toBeNull();
    });

    it("labels weak grounding with a warning tone", () => {
        expect(terminalBadge("weak")).toEqual({ label: "Weak grounding", tone: "warning" });
    });

    it("labels not-found with a muted tone — an absence is not a warning", () => {
        expect(terminalBadge("notfound")).toEqual({ label: "Not found", tone: "muted" });
    });

    it("labels a failed query with an error tone, distinct from weak grounding", () => {
        expect(terminalBadge("error")).toEqual({ label: "Couldn't reach Jarvis", tone: "error" });
        expect(terminalBadge("error")).not.toEqual(terminalBadge("weak"));
    });
});
