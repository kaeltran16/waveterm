import { describe, expect, it } from "vitest";
import { fixtureRun, fixtureSession, tailLines } from "./sessions-page-fixtures.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// every key of wshrpc.SessionActivity, less the run-link fields a plain session leaves out
const SESSION_KEYS = [
    "id",
    "runtime",
    "projectpath",
    "projectname",
    "branch",
    "task",
    "model",
    "tokenstotal",
    "lastactivets",
    "resumecommand",
    "transcriptpath",
    "status",
    "startedts",
    "durationms",
    "events",
];

describe("fixtureSession", () => {
    it("fills every SessionActivity field", () => {
        const s = fixtureSession();
        for (const key of SESSION_KEYS) expect(s).toHaveProperty(key);
        expect(s.runtime).toBe("claude");
        expect(s.status).toBe("done");
        expect(s.resumecommand).toBe(`claude --resume ${s.id}`);
        expect(s.transcriptpath).toBe(`C:\\arc-verify-sessions-fixture\\${s.id}.jsonl`);
        expect(s.events).toHaveLength(1);
        expect(s.events[0].type).toBe("started");
        expect(s.lastactivets).toBeGreaterThan(0);
        expect(s.lastactivets).toBeLessThanOrEqual(Date.now());
    });

    it("applies overrides over the defaults", () => {
        expect(fixtureSession({ status: "waiting", task: "ask me" })).toMatchObject({ status: "waiting", task: "ask me" });
    });

    it("ids are UUIDs", () => {
        const a = fixtureSession();
        const b = fixtureSession();
        expect(a.id).toMatch(UUID);
        expect(b.id).toMatch(UUID);
        expect(a.id).not.toBe(b.id);
    });
});

describe("fixtureRun", () => {
    it("links the run to its dag", () => {
        const { run, dag } = fixtureRun({ status: "executing", dagStatus: "running", tasks: [{ id: "t-1" }, { id: "t-2" }] });
        expect(run.oid).toMatch(UUID);
        expect(dag.oid).toMatch(UUID);
        expect(run.dagoref).toBe(dag.oid);
        expect(dag.runid).toBe(run.oid);
        expect(run.status).toBe("executing");
        expect(dag.status).toBe("running");
        expect(dag.tasks.map((t) => t.id)).toEqual(["t-1", "t-2"]);
    });
});

describe("tailLines", () => {
    it("returns all for -1 and the last N otherwise", () => {
        const lines = ["a", "b", "c", "d"];
        expect(tailLines(lines, -1)).toEqual(lines);
        expect(tailLines(lines, 0)).toEqual(lines);
        expect(tailLines(lines, 2)).toEqual(["c", "d"]);
        expect(tailLines(lines, 10)).toEqual(lines);
    });
});
