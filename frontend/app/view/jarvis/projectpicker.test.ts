// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { homeFromInfo, pickerSections, projectWhere, recentNames } from "./projectpicker";

describe("homeFromInfo", () => {
    const info = (over: Partial<FileInfo>) => ({ path: "~", dir: "C:/Users", name: "kael02", ...over }) as FileInfo;

    it("rebuilds home from the expanded parent and name, since the server hands home back as ~", () => {
        expect(homeFromInfo(info({}))).toBe("C:/Users/kael02");
        expect(projectWhere("C:\\Users\\kael02\\IdeaProjects\\waveterm", homeFromInfo(info({})))).toBe("IdeaProjects");
    });

    it("rebuilds a home directly under the root without doubling the separator", () => {
        expect(homeFromInfo(info({ dir: "/", name: "root" }))).toBe("/root");
    });

    it("takes an already-expanded path as is", () => {
        expect(homeFromInfo(info({ path: "C:\\Users\\kael02" }))).toBe("C:\\Users\\kael02");
    });

    it("is unknown when the stat failed, was not found, or cannot be rebuilt", () => {
        expect(homeFromInfo(null)).toBe("");
        expect(homeFromInfo(info({ notfound: true }))).toBe("");
        expect(homeFromInfo(info({ dir: "" }))).toBe("");
        expect(homeFromInfo(info({ path: "" }))).toBe("");
    });
});

describe("projectWhere", () => {
    const home = "C:\\Users\\kael02";

    it("names the parent folder relative to home for a project inside it", () => {
        expect(projectWhere("C:\\Users\\kael02\\IdeaProjects\\waveterm", home)).toBe("IdeaProjects");
        expect(projectWhere("C:\\Users\\kael02\\SIEM\\src\\cyber_ai\\cyber_assistant", home)).toBe(
            "SIEM\\src\\cyber_ai"
        );
    });

    it("says ~ for a project directly in home, since its relative parent would be blank", () => {
        expect(projectWhere("C:\\Users\\kael02\\waveterm", home)).toBe("~");
    });

    it("shows the full parent path for a project on another drive", () => {
        expect(projectWhere("D:\\work\\opal", home)).toBe("D:\\work");
        expect(projectWhere("D:\\opal", home)).toBe("D:\\");
    });

    it("shows the full parent path for a sibling of home rather than climbing out of it", () => {
        expect(projectWhere("C:\\Users\\other\\repo", home)).toBe("C:\\Users\\other");
        expect(projectWhere("C:\\Users\\kael02x\\repo", home)).toBe("C:\\Users\\kael02x");
    });

    it("handles forward slashes on either side", () => {
        expect(projectWhere("C:/Users/kael02/IdeaProjects/waveterm", home)).toBe("IdeaProjects");
        expect(projectWhere("/home/k/src/app", "/home/k")).toBe("src");
        expect(projectWhere("/srv/app", "/home/k")).toBe("/srv");
    });

    it("ignores a trailing separator on the path or home", () => {
        expect(projectWhere("C:\\Users\\kael02\\IdeaProjects\\waveterm\\", home + "\\")).toBe("IdeaProjects");
        expect(projectWhere("/home/k/src/app/", "/home/k/")).toBe("src");
    });

    it("matches the drive letter regardless of case", () => {
        expect(projectWhere("c:\\Users\\kael02\\IdeaProjects\\waveterm", home)).toBe("IdeaProjects");
    });

    it("is empty for a project that is home itself", () => {
        expect(projectWhere("C:\\Users\\kael02", home)).toBe("");
        expect(projectWhere("C:/Users/kael02/", home)).toBe("");
    });

    it("shows the full parent path when home is unknown", () => {
        expect(projectWhere("C:\\Users\\kael02\\IdeaProjects\\waveterm", "")).toBe("C:\\Users\\kael02\\IdeaProjects");
    });
});

describe("recentNames", () => {
    const names = ["a", "b", "c", "d"];

    it("keeps the shared recent order, newest first", () => {
        expect(recentNames(names, ["c", "a"])).toEqual(["c", "a"]);
    });

    it("drops recent names that are no longer registered projects", () => {
        expect(recentNames(names, ["gone", "b"])).toEqual(["b"]);
    });

    it("returns at most the limit, 3 by default", () => {
        expect(recentNames(names, ["d", "c", "b", "a"])).toEqual(["d", "c", "b"]);
        expect(recentNames(names, ["d", "c"], 1)).toEqual(["d"]);
    });
});

describe("pickerSections", () => {
    const where: Record<string, string> = {
        waveterm: "IdeaProjects",
        opal: "IdeaProjects",
        cyber_assistant: "SIEM\\src\\cyber_ai",
        "MP-Frontend": "SIEM\\src\\ManagementPanel",
        beta: "work",
    };
    const whereOf = (name: string) => where[name] ?? "";
    const names = Object.keys(where);

    it("with an empty query, lists Recent then every other project by name, case-insensitively", () => {
        expect(pickerSections(names, ["waveterm", "opal"], "  ", whereOf)).toEqual({
            recent: ["waveterm", "opal"],
            rest: ["beta", "cyber_assistant", "MP-Frontend"],
            restLabel: "All projects",
        });
    });

    it("with a query, drops Recent and ranks one Matches list", () => {
        const s = pickerSections(names, ["waveterm"], "wave", whereOf);
        expect(s.recent).toEqual([]);
        expect(s.rest).toEqual(["waveterm"]);
        expect(s.restLabel).toBe("Matches");
    });

    it("matches a project by its where, after the name matches", () => {
        const s = pickerSections(names, [], "siem", whereOf);
        expect(s.rest).toEqual(["cyber_assistant", "MP-Frontend"]);
        // beta sorts before opal by name, so only name-first ordering puts opal ahead
        const betaUnderOpal = (name: string) => (name === "beta" ? "opal-things" : whereOf(name));
        expect(pickerSections(names, [], "opal", betaUnderOpal).rest).toEqual(["opal", "beta"]);
    });

    it("returns an empty Matches list when nothing matches", () => {
        expect(pickerSections(names, ["waveterm"], "zzzq", whereOf)).toEqual({
            recent: [],
            rest: [],
            restLabel: "Matches",
        });
    });
});
