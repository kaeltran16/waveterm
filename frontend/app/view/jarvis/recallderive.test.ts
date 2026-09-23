import { describe, expect, it } from "vitest";
import { ageLabel } from "./recallderive";

describe("ageLabel", () => {
    it("renders coarse relative ages", () => {
        expect(ageLabel(30_000)).toBe("just now");
        expect(ageLabel(5 * 60_000)).toBe("5m ago");
        expect(ageLabel(3 * 3_600_000)).toBe("3h ago");
        expect(ageLabel(2 * 86_400_000)).toBe("2d ago");
    });
});
