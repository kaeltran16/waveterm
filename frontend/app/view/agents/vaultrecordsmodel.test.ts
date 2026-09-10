import { describe, expect, it } from "vitest";
import { buildVaultRecordGroups, recordTimelineMeta, resolveVaultRecordId } from "./vaultrecordsmodel";

function record(id: string, status: string, updated: number, objective = id, ticket = ""): SpaceSummary {
    return { id, status, updated, objective, ticket };
}

describe("Vault Records projection", () => {
    it("groups every status in ledger order without hiding archived records", () => {
        const groups = buildVaultRecordGroups(
            [
                record("a", "active", 40),
                record("z", "archived", 50),
                record("c", "completed", 30),
                record("p", "paused", 20),
                record("a2", "active", 10),
            ],
            ""
        );
        expect(groups.map((group) => [group.status, group.rows.map((row) => row.id)])).toEqual([
            ["active", ["a", "a2"]],
            ["paused", ["p"]],
            ["completed", ["c"]],
            ["archived", ["z"]],
        ]);
    });

    it.each([
        ["objective", "BRIEF", "a"],
        ["ticket", "wave-22", "b"],
        ["status", "ARCHIVED", "c"],
    ])("filters case-insensitively by %s", (_field, query, expectedId) => {
        const groups = buildVaultRecordGroups(
            [
                record("a", "active", 3, "Jarvis Brief", "WAVE-1"),
                record("b", "paused", 2, "Queue", "WAVE-22"),
                record("c", "archived", 1, "Legacy rail", "WAVE-3"),
            ],
            query
        );
        expect(groups.flatMap((group) => group.rows.map((row) => row.id))).toEqual([expectedId]);
    });

    it("falls back to the first visible record when filtering removes the selection", () => {
        const groups = buildVaultRecordGroups(
            [record("a", "active", 2, "alpha"), record("b", "paused", 1, "beta")],
            "beta"
        );
        expect(resolveVaultRecordId(groups, "a")).toBe("b");
        expect(resolveVaultRecordId(groups, "b")).toBe("b");
    });

    it("returns no selection for an empty result", () => {
        expect(resolveVaultRecordId([], "a")).toBeUndefined();
    });

    it("labels created and updated dates without fabricating zero timestamps", () => {
        const detail = {
            created: Date.UTC(2026, 8, 9),
            updated: Date.UTC(2026, 8, 10),
        } as DossierDetail;
        expect(recordTimelineMeta(detail)).toEqual({
            created: "Created 2026-09-09",
            updated: "Updated 2026-09-10",
        });
        expect(recordTimelineMeta({ created: 0, updated: 0 } as DossierDetail)).toEqual({
            created: "Created unknown",
            updated: "Updated unknown",
        });
    });
});
