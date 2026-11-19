// Pure-helper coverage for the pi status extension (sessionTitle / basename / detailForTool) plus
// the P4 registration gate. The lifecycle-reporting behavior itself is covered by the embedded
// template's test in cmd/wsh/cmd/pi-status-extension.test.ts; this file tests beside the source per
// repo convention.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basename, detailForTool, registerWavetermStatus, sessionTitle } from "./waveterm-status";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// a child process whose stdin collects what the extension writes; `fail` makes it emit a spawn error
function fakeChild(fail = false) {
    const written: string[] = [];
    const handlers = new Map<string, (e?: unknown) => void>();
    const child = {
        stdin: { on: vi.fn(), end: (s: string) => written.push(s) },
        on: (ev: string, fn: (e?: unknown) => void) => handlers.set(ev, fn),
    };
    if (fail) queueMicrotask(() => handlers.get("error")?.(new Error("spawn wsh ENOENT")));
    return { child, written };
}

beforeEach(() => {
    spawnMock.mockReset();
});
afterEach(() => {
    delete process.env.WAVETERM_BLOCKID;
});

describe("sessionTitle", () => {
    it("returns the explicit session name, trimmed", () => {
        expect(sessionTitle({ getSessionName: () => "  fix the bug  " })).toBe("fix the bug");
    });

    it("returns empty when the session has no explicit name", () => {
        expect(sessionTitle({ getSessionName: () => "" })).toBe("");
        // the backend PiTitleProvider generates auto titles — this extension never fabricates one
        expect(sessionTitle(undefined)).toBe("");
    });
});

describe("basename", () => {
    it("strips posix and windows directory prefixes", () => {
        expect(basename("src/foo.ts")).toBe("foo.ts");
        expect(basename("/home/jane/proj/main.go")).toBe("main.go");
        expect(basename("C:\\Users\\Jane Doe\\file.rs")).toBe("file.rs");
    });

    it("passes a bare name through", () => {
        expect(basename("out.md")).toBe("out.md");
    });
});

describe("detailForTool", () => {
    it("prefixes read/edit/write with the file basename", () => {
        expect(detailForTool("read", { path: "src/foo.ts" })).toBe("reading foo.ts");
        expect(detailForTool("edit", { path: "C:\\Users\\Jane Doe\\main.go" })).toBe("editing main.go");
        expect(detailForTool("write", { path: "/home/jane/new.rs" })).toBe("writing new.rs");
    });

    it("accepts the claude-style file_path key", () => {
        expect(detailForTool("write", { file_path: "out.md" })).toBe("writing out.md");
    });

    it("shows the bash command truncated to 60 chars", () => {
        expect(detailForTool("bash", { command: "npm test" })).toBe("running npm test");
        const long = "npm test -- --runInBand ".repeat(10);
        const detail = detailForTool("Bash", { command: long });
        expect(detail).toBe("running " + long.slice(0, 60));
    });

    it("falls back to the bare tool name", () => {
        expect(detailForTool("Read", {})).toBe("read");
        expect(detailForTool("WebFetch", { url: "https://x" })).toBe("webfetch");
        expect(detailForTool("", {})).toBe("tool");
        expect(detailForTool(undefined, undefined)).toBe("tool");
    });
});

describe("pi's end report", () => {
    const ctx = {
        cwd: "proj",
        sessionManager: { getSessionFile: () => "s.jsonl", getSessionId: () => "s1", getSessionName: () => "" },
        model: { provider: "p", id: "m" },
    };
    const argsOf = async (event: string) => {
        process.env.WAVETERM_BLOCKID = "block:test";
        const exec = vi.fn(async () => {});
        const handlers = new Map<string, (e: any, c: any) => unknown>();
        registerWavetermStatus({ on: (e: string, fn: any) => handlers.set(e, fn), exec }, "wsh");
        await handlers.get(event)!({}, ctx);
        return exec.mock.calls.at(-1)![1] as string[];
    };

    it("flags only the session_shutdown report as ended", async () => {
        expect(await argsOf("session_shutdown")).toContain("--ended");
        expect(await argsOf("session_start")).not.toContain("--ended");
        expect(await argsOf("agent_settled")).not.toContain("--ended");
    });
});

describe("pi session replacement", () => {
    const sessionCtx = (file: string) => ({
        cwd: "proj",
        sessionManager: { getSessionFile: () => file, getSessionId: () => "s1", getSessionName: () => "" },
        model: { provider: "p", id: "m" },
    });
    const setup = () => {
        process.env.WAVETERM_BLOCKID = "block:test";
        const exec = vi.fn(async () => {});
        const handlers = new Map<string, (e: any, c: any) => unknown>();
        registerWavetermStatus({ on: (e: string, fn: any) => handlers.set(e, fn), exec }, "wsh");
        return { exec, handlers };
    };

    it.each(["new", "resume", "fork", "reload"])("a %s shutdown reports no --ended", async (reason) => {
        const { exec, handlers } = setup();
        await handlers.get("session_shutdown")!({ reason }, sessionCtx("old.jsonl"));
        expect(exec.mock.calls.at(-1)![1]).not.toContain("--ended");
    });

    it.each([{ reason: "quit" }, {}])("a quit shutdown (%j) reports --ended", async (event) => {
        const { exec, handlers } = setup();
        await handlers.get("session_shutdown")!(event, sessionCtx("old.jsonl"));
        expect(exec.mock.calls.at(-1)![1]).toContain("--ended");
    });

    it.each(["new", "resume", "fork"])("a %s start reports the new session file", async (reason) => {
        const { exec, handlers } = setup();
        await handlers.get("session_start")!({ reason }, sessionCtx("new.jsonl"));
        const args = exec.mock.calls.at(-1)![1] as string[];
        expect(args[args.indexOf("--transcript") + 1]).toBe("new.jsonl");
        expect(args).not.toContain("--ended");
    });
});

describe("pi command publishing", () => {
    const ctx = {
        cwd: "proj",
        sessionManager: { getSessionFile: () => "s.jsonl", getSessionId: () => "s1", getSessionName: () => "" },
    };
    const commands = [
        { name: "review", description: "review the diff", source: "prompt", sourceInfo: { path: "/x/review.md" } },
        { name: "deploy", source: "extension" },
        { name: "skill:lint", description: "lint", source: "skill" },
    ];
    const setup = () => {
        process.env.WAVETERM_BLOCKID = "block:test";
        const handlers = new Map<string, (e: any, c: any) => unknown>();
        const pi = {
            on: (e: string, fn: any) => handlers.set(e, fn),
            exec: vi.fn(async () => {}),
            getCommands: () => commands,
        };
        registerWavetermStatus(pi, "wsh");
        return { handlers };
    };

    it("sends pi's commands to wsh claudecmds set on stdin, in order", async () => {
        const { child, written } = fakeChild();
        spawnMock.mockReturnValue(child);
        const { handlers } = setup();
        await handlers.get("session_start")!({ reason: "startup" }, ctx);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual(["wsh", ["claudecmds", "set"]]);
        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0])).toEqual([
            { name: "review", description: "review the diff", source: "prompt" },
            { name: "deploy", description: "", source: "extension" },
            { name: "skill:lint", description: "lint", source: "skill" },
        ]);
    });

    it("strips a leading slash from a command name", async () => {
        const { child, written } = fakeChild();
        spawnMock.mockReturnValue(child);
        process.env.WAVETERM_BLOCKID = "block:test";
        const handlers = new Map<string, (e: any, c: any) => unknown>();
        registerWavetermStatus(
            {
                on: (e: string, fn: any) => handlers.set(e, fn),
                exec: async () => {},
                getCommands: () => [{ name: "/deploy", source: "extension" }],
            },
            "wsh"
        );
        await handlers.get("session_start")!({}, ctx);
        expect(JSON.parse(written[0])[0].name).toBe("deploy");
    });

    it("publishes again at every session_start", async () => {
        spawnMock.mockImplementation(() => fakeChild().child);
        const { handlers } = setup();
        await handlers.get("session_start")!({ reason: "startup" }, ctx);
        await handlers.get("session_start")!({ reason: "reload" }, ctx);
        expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("runs nothing outside an Arc block", () => {
        delete process.env.WAVETERM_BLOCKID;
        const on = vi.fn();
        registerWavetermStatus({ on, getCommands: () => commands }, "wsh");
        expect(on).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it("survives a failing wsh without throwing", async () => {
        spawnMock.mockReturnValue(fakeChild(true).child);
        const { handlers } = setup();
        const write = vi.spyOn(process.stderr, "write");
        const out = vi.spyOn(process.stdout, "write");
        await expect(handlers.get("session_start")!({ reason: "startup" }, ctx)).resolves.toBeUndefined();
        await new Promise((r) => setTimeout(r, 0));
        expect(write).not.toHaveBeenCalled();
        expect(out).not.toHaveBeenCalled();
        write.mockRestore();
        out.mockRestore();
    });

    it("survives a spawn that throws", async () => {
        spawnMock.mockImplementation(() => {
            throw new Error("EINVAL");
        });
        const { handlers } = setup();
        await expect(handlers.get("session_start")!({ reason: "startup" }, ctx)).resolves.toBeUndefined();
    });

    it("still reports status when getCommands throws", async () => {
        process.env.WAVETERM_BLOCKID = "block:test";
        const exec = vi.fn(async () => {});
        const handlers = new Map<string, (e: any, c: any) => unknown>();
        registerWavetermStatus(
            {
                on: (e: string, fn: any) => handlers.set(e, fn),
                exec,
                getCommands: () => {
                    throw new Error("not bound");
                },
            },
            "wsh"
        );
        await expect(handlers.get("session_start")!({}, ctx)).resolves.toBeUndefined();
        expect(exec).toHaveBeenCalled();
    });
});

describe("registerWavetermStatus", () => {
    it("registers nothing outside a Wave block", () => {
        delete process.env.WAVETERM_BLOCKID;
        const on = vi.fn();
        registerWavetermStatus({ on }, "wsh");
        expect(on).not.toHaveBeenCalled();
    });

    it("registers the lifecycle reporters inside a Wave block", () => {
        process.env.WAVETERM_BLOCKID = "block:test";
        const on = vi.fn();
        registerWavetermStatus({ on }, "wsh");
        expect(on).toHaveBeenCalled();
    });
});
