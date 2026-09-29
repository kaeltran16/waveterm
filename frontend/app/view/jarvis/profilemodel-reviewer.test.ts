// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    applyWorkersChoice,
    defaultReach,
    overrideSummary,
    overridesRow,
    reviewerRow,
    workersRow,
} from "./profilemodel";

const ROUTE = { runtime: "claude", model: "sonnet" } as RoutePin;
const OTHER = { runtime: "pi", model: "gpt" } as RoutePin;

describe("workersRow", () => {
    it("reads the global profile's own workers setting in global scope", () => {
        expect(workersRow({}, {}, false)).toEqual({ picks: false, route: null, inherited: false });
        expect(workersRow({ reviewerpicks: true }, {}, false)).toEqual({ picks: true, route: null, inherited: false });
        expect(workersRow({ workerroute: ROUTE }, {}, false)).toEqual({ picks: false, route: ROUTE, inherited: false });
    });

    // an inherited row shows what the global resolves to, with the Global dot, not a blank
    it("shows the global's setting as inherited when the project sets neither half", () => {
        expect(workersRow({}, { reviewerpicks: true }, true)).toEqual({ picks: true, route: null, inherited: true });
        expect(workersRow({}, { workerroute: ROUTE }, true)).toEqual({ picks: false, route: ROUTE, inherited: true });
        expect(workersRow({ parallelism: 2 }, {}, true)).toEqual({ picks: false, route: null, inherited: true });
    });

    it("treats either half of the pair as the project's own setting", () => {
        expect(workersRow({ reviewerpicks: false }, { workerroute: ROUTE }, true)).toEqual({
            picks: false,
            route: null,
            inherited: false,
        });
        expect(workersRow({ reviewerpicks: true }, { workerroute: ROUTE }, true)).toEqual({
            picks: true,
            route: null,
            inherited: false,
        });
        expect(workersRow({ workerroute: OTHER }, { reviewerpicks: true }, true)).toEqual({
            picks: false,
            route: OTHER,
            inherited: false,
        });
    });
});

describe("applyWorkersChoice", () => {
    it("writes Reviewer picks with no route", () => {
        expect(applyWorkersChoice({ workerroute: ROUTE, parallelism: 2 }, { kind: "picks" }, true)).toEqual({
            reviewerpicks: true,
            parallelism: 2,
        });
        expect(applyWorkersChoice({ workerroute: ROUTE }, { kind: "picks" }, false)).toEqual({ reviewerpicks: true });
    });

    it("writes a route and clears Reviewer picks", () => {
        expect(applyWorkersChoice({ reviewerpicks: true }, { kind: "route", route: ROUTE }, true)).toEqual({
            workerroute: ROUTE,
        });
        expect(applyWorkersChoice({ reviewerpicks: true }, { kind: "route", route: ROUTE }, false)).toEqual({
            workerroute: ROUTE,
        });
    });

    // a project must be able to override a global model back to the lead, so it states false
    it("writes reviewerpicks false and no route for Same as lead in project scope", () => {
        expect(applyWorkersChoice({ workerroute: ROUTE }, { kind: "lead" }, true)).toEqual({ reviewerpicks: false });
        expect(applyWorkersChoice({ reviewerpicks: true }, { kind: "lead" }, true)).toEqual({ reviewerpicks: false });
    });

    it("unsets both halves for Same as lead in global scope", () => {
        expect(applyWorkersChoice({ reviewerpicks: true, landing: "branch" }, { kind: "lead" }, false)).toEqual({
            landing: "branch",
        });
        expect(applyWorkersChoice({ workerroute: ROUTE }, { kind: "lead" }, false)).toEqual({});
    });

    it("removes both halves on Reset so the project inherits again", () => {
        const reset = applyWorkersChoice({ reviewerpicks: false, parallelism: 3 }, { kind: "reset" }, true);
        expect(reset).toEqual({ parallelism: 3 });
        expect(workersRow(reset, { workerroute: ROUTE }, true)).toEqual({
            picks: false,
            route: ROUTE,
            inherited: true,
        });
        expect(applyWorkersChoice({ workerroute: ROUTE }, { kind: "reset" }, true)).toEqual({});
    });
});

describe("reviewerRow", () => {
    it("reads the global's own reviewer route in global scope", () => {
        expect(reviewerRow({}, {}, false)).toEqual({ value: null, inheritedLabel: "Same as lead" });
        expect(reviewerRow({ reviewerroute: ROUTE }, {}, false)).toEqual({
            value: ROUTE,
            inheritedLabel: "Same as lead",
        });
    });

    it("inherits the global's reviewer route in project scope until the project sets one", () => {
        expect(reviewerRow({}, {}, true)).toEqual({ value: null, inheritedLabel: "Same as lead" });
        expect(overridesRow({}, "reviewerroute")).toBe(false);
        expect(reviewerRow({}, { reviewerroute: ROUTE }, true)).toEqual({
            value: null,
            inheritedLabel: "Same as global",
        });
        const own = { reviewerroute: OTHER };
        expect(reviewerRow(own, { reviewerroute: ROUTE }, true)).toEqual({
            value: OTHER,
            inheritedLabel: "Same as global",
        });
        expect(overridesRow(own, "reviewerroute")).toBe(true);
    });
});

describe("reviewer settings in the override bookkeeping", () => {
    it("counts the workers pair as one row, and the reviewer route as its own", () => {
        expect(overridesRow({ reviewerpicks: false }, "workerroute")).toBe(true);
        expect(overridesRow({ workerroute: ROUTE }, "workerroute")).toBe(true);
        expect(overridesRow({ reviewerroute: ROUTE }, "workerroute")).toBe(false);
        expect(overridesRow({ reviewerroute: ROUTE }, "reviewerroute")).toBe(true);
        expect(overrideSummary({ reviewerpicks: false })).toBe("1 set for this project");
        expect(overrideSummary({ reviewerpicks: true, reviewerroute: ROUTE })).toBe("2 set for this project");
    });

    it("reaches only the projects that set neither half of the workers pair", () => {
        const projects = [
            { name: "opal", override: { reviewerpicks: false } },
            { name: "wave", override: {} },
            { name: "arc", override: { reviewerroute: ROUTE } },
        ];
        expect(defaultReach(projects, "workerroute")).toEqual({ main: "2 of 3 projects", sub: "opal sets its own" });
        expect(defaultReach(projects, "reviewerroute")).toEqual({ main: "2 of 3 projects", sub: "arc sets its own" });
    });
});
