// Pure-helper coverage for the pi status extension (sessionTitle / basename / detailForTool) plus
// the P4 registration gate. The lifecycle-reporting behavior itself is covered by the embedded
// template's test in cmd/wsh/cmd/pi-status-extension.test.ts; this file tests beside the source per
// repo convention.
import { afterEach, describe, expect, it, vi } from "vitest";
import { basename, detailForTool, registerWavetermStatus, sessionTitle } from "./waveterm-status";

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
