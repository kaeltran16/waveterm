import { describe, expect, it } from "vitest";
import {
    aggregateStatus,
    badgeToStatus,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    flattenVisualOrder,
    needsYouTarget,
    NO_CWD_LABEL,
    toggleCollapsed,
    type SessionInput,
} from "./sessionviewmodel";

describe("cwdToServiceLabel", () => {
    it("uses the last path segment (POSIX)", () => {
        expect(cwdToServiceLabel("/home/user/src/CorrelationEngine")).toBe("CorrelationEngine");
    });
    it("uses the last path segment (Windows)", () => {
        expect(cwdToServiceLabel("C:\\Users\\k\\src\\KafkaToSolr")).toBe("KafkaToSolr");
    });
    it("ignores a trailing separator", () => {
        expect(cwdToServiceLabel("/a/b/")).toBe("b");
        expect(cwdToServiceLabel("C:\\a\\b\\")).toBe("b");
    });
    it("falls back when cwd is missing or empty", () => {
        expect(cwdToServiceLabel(undefined)).toBe(NO_CWD_LABEL);
        expect(cwdToServiceLabel("")).toBe(NO_CWD_LABEL);
    });
    it("falls back for a root path", () => {
        expect(cwdToServiceLabel("/")).toBe(NO_CWD_LABEL);
        expect(cwdToServiceLabel("\\")).toBe(NO_CWD_LABEL);
    });
});

describe("badgeToStatus", () => {
    it("maps the working color to working", () => {
        expect(badgeToStatus({ color: "#3fb950" })).toBe("working");
    });
    it("is case-insensitive on the hex", () => {
        expect(badgeToStatus({ color: "#3FB950" })).toBe("working");
    });
    it("maps the waiting color to waiting", () => {
        expect(badgeToStatus({ color: "#d29922" })).toBe("waiting");
    });
    it("maps anything else to idle", () => {
        expect(badgeToStatus({ color: "#999999" })).toBe("idle");
        expect(badgeToStatus({})).toBe("idle");
    });
    it("maps missing badge to idle", () => {
        expect(badgeToStatus(undefined)).toBe("idle");
        expect(badgeToStatus(null)).toBe("idle");
    });
});

describe("aggregateStatus", () => {
    it("prioritizes waiting over everything", () => {
        expect(aggregateStatus(["idle", "working", "waiting"])).toBe("waiting");
    });
    it("prioritizes working over idle", () => {
        expect(aggregateStatus(["idle", "working", "idle"])).toBe("working");
    });
    it("returns idle when all idle", () => {
        expect(aggregateStatus(["idle", "idle"])).toBe("idle");
    });
    it("returns idle for an empty list", () => {
        expect(aggregateStatus([])).toBe("idle");
    });
});

function input(overrides: Partial<SessionInput>): SessionInput {
    const cwd = overrides.cwd ?? "/src/CorrelationEngine";
    return {
        tabId: "t1",
        name: "tab",
        agent: "claude",
        pinned: false,
        cwd,
        serviceLabel: cwdToServiceLabel(cwd),
        status: "idle",
        active: false,
        ...overrides,
    };
}

describe("buildSessionViewModel", () => {
    it("routes pinned sessions into the pinned group with service in the label", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", agent: "claude", cwd: "/src/CorrelationEngine", pinned: true }),
        ]);
        expect(vm.pinned).toHaveLength(1);
        expect(vm.pinned[0].label).toBe("claude · CorrelationEngine");
        expect(vm.groups).toHaveLength(0);
    });

    it("groups non-pinned sessions by service label", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/CorrelationEngine" }),
            input({ tabId: "t2", cwd: "/src/CorrelationEngine" }),
            input({ tabId: "t3", cwd: "/src/KafkaToSolr" }),
        ]);
        expect(vm.groups.map((g) => g.label)).toEqual(["CorrelationEngine", "KafkaToSolr"]);
        expect(vm.groups[0].sessions).toHaveLength(2);
        expect(vm.groups[1].sessions).toHaveLength(1);
    });

    it("preserves first-appearance order for groups", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/Zeta" }),
            input({ tabId: "t2", cwd: "/src/Alpha" }),
        ]);
        expect(vm.groups.map((g) => g.label)).toEqual(["Zeta", "Alpha"]);
    });

    it("computes a group's aggregate status", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/X", status: "idle" }),
            input({ tabId: "t2", cwd: "/src/X", status: "waiting" }),
        ]);
        expect(vm.groups[0].aggregateStatus).toBe("waiting");
    });

    it("labels grouped rows by agent, falling back to tab name", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", agent: "codex", name: "ignored", cwd: "/src/X" }),
            input({ tabId: "t2", agent: undefined, name: "my-tab", cwd: "/src/X" }),
        ]);
        expect(vm.groups[0].sessions[0].label).toBe("codex");
        expect(vm.groups[0].sessions[1].label).toBe("my-tab");
    });

    it("marks waiting rows as blocked and carries active/pinned flags", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/X", status: "waiting", active: true }),
        ]);
        const row = vm.groups[0].sessions[0];
        expect(row.blocked).toBe(true);
        expect(row.active).toBe(true);
    });

    it("groups by the provided serviceLabel, not the cwd basename", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/CorrelationEngine", serviceLabel: "ServiceA" }),
            input({ tabId: "t2", cwd: "/other/path", serviceLabel: "ServiceA" }),
        ]);
        expect(vm.groups).toHaveLength(1);
        expect(vm.groups[0].label).toBe("ServiceA");
        expect(vm.groups[0].sessions).toHaveLength(2);
    });
});

describe("buildSessionViewModel — detail", () => {
    it("carries the detail string onto the row", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/X", detail: "editing X.java" }),
        ]);
        expect(vm.groups[0].sessions[0].detail).toBe("editing X.java");
    });
    it("leaves detail undefined when not provided", () => {
        const vm = buildSessionViewModel([input({ tabId: "t1", cwd: "/src/X" })]);
        expect(vm.groups[0].sessions[0].detail).toBeUndefined();
    });
});

describe("toggleCollapsed", () => {
    it("adds a label that is not present", () => {
        expect(toggleCollapsed([], "ServiceA")).toEqual(["ServiceA"]);
        expect(toggleCollapsed(["X"], "ServiceA")).toEqual(["X", "ServiceA"]);
    });
    it("removes a label that is present", () => {
        expect(toggleCollapsed(["X", "ServiceA"], "ServiceA")).toEqual(["X"]);
    });
    it("does not mutate the input array", () => {
        const input = ["X"];
        toggleCollapsed(input, "ServiceA");
        expect(input).toEqual(["X"]);
    });
});

describe("flattenVisualOrder", () => {
    it("lists pinned rows first, then group rows in order", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "p1", cwd: "/src/A", pinned: true }),
            input({ tabId: "g1", cwd: "/src/B" }),
            input({ tabId: "g2", cwd: "/src/C" }),
        ]);
        expect(flattenVisualOrder(vm).map((r) => r.tabId)).toEqual(["p1", "g1", "g2"]);
    });
});

describe("cycleTarget", () => {
    const vm = () =>
        buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true }),
            input({ tabId: "t2", cwd: "/src/B" }),
            input({ tabId: "t3", cwd: "/src/C" }),
        ]);
    it("moves to the next row", () => {
        expect(cycleTarget(vm(), 1)).toBe("t2");
    });
    it("wraps from last to first", () => {
        const v = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A" }),
            input({ tabId: "t2", cwd: "/src/B" }),
            input({ tabId: "t3", cwd: "/src/C", active: true }),
        ]);
        expect(cycleTarget(v, 1)).toBe("t1");
    });
    it("moves to the previous row, wrapping", () => {
        expect(cycleTarget(vm(), -1)).toBe("t3");
    });
    it("returns undefined when there are no rows", () => {
        expect(cycleTarget(buildSessionViewModel([]), 1)).toBeUndefined();
    });
    it("starts at the first row for next when none is active", () => {
        const v = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A" }),
            input({ tabId: "t2", cwd: "/src/B" }),
        ]);
        expect(cycleTarget(v, 1)).toBe("t1");
    });
});

describe("needsYouTarget", () => {
    it("returns the next waiting row after the active one, wrapping", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true }),
            input({ tabId: "t2", cwd: "/src/B", status: "working" }),
            input({ tabId: "t3", cwd: "/src/C", status: "waiting" }),
        ]);
        expect(needsYouTarget(vm)).toBe("t3");
    });
    it("wraps past the active row to find an earlier waiting row", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", status: "waiting" }),
            input({ tabId: "t2", cwd: "/src/B", active: true }),
        ]);
        expect(needsYouTarget(vm)).toBe("t1");
    });
    it("returns undefined when nothing is waiting", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true, status: "working" }),
        ]);
        expect(needsYouTarget(vm)).toBeUndefined();
    });
});
