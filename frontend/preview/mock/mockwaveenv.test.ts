import { base64ToString } from "@/util/util";
import { describe, expect, it, vi } from "vitest";
import { DefaultMockFilesystem } from "./mockfilesystem";
import { makeMockWaveEnv } from "./mockwaveenv";

const { showPreviewContextMenu } = vi.hoisted(() => ({
    showPreviewContextMenu: vi.fn(),
}));

vi.mock("../preview-contextmenu", () => ({
    showPreviewContextMenu,
}));

describe("makeMockWaveEnv", () => {
    it("uses the preview context menu by default", () => {
        const env = makeMockWaveEnv();
        const menu = [{ label: "Open" }];
        const event = { stopPropagation: vi.fn() } as any;

        env.showContextMenu(menu, event);

        expect(showPreviewContextMenu).toHaveBeenCalledWith(menu, event);
    });

    it("provides a populated mock filesystem rooted at /Users/mike", () => {
        expect(DefaultMockFilesystem.homePath).toBe("/Users/mike");
        expect(DefaultMockFilesystem.fileCount).toBeGreaterThanOrEqual(100);
        expect(DefaultMockFilesystem.directoryCount).toBeGreaterThanOrEqual(10);
    });

    it("implements file info, read, list, and join commands", async () => {
        const { makeMockWaveEnv } = await import("./mockwaveenv");
        const env = makeMockWaveEnv();

        const bashrcInfo = await env.rpc.FileInfoCommand(null as any, {
            info: { path: "wsh://local//Users/mike/.bashrc" },
        });
        expect(bashrcInfo.path).toBe("/Users/mike/.bashrc");
        expect(bashrcInfo.mimetype).toBe("text/plain");

        const bashrcData = await env.rpc.FileReadCommand(null as any, {
            info: { path: "wsh://local//Users/mike/.bashrc" },
        });
        expect(base64ToString(bashrcData.data64)).toContain('alias gs="git status -sb"');

        const dirRead = await env.rpc.FileReadCommand(null as any, {
            info: { path: "/Users/mike/waveterm" },
        });
        expect(dirRead.entries.some((entry) => entry.name === "docs" && entry.isdir)).toBe(true);

        const joined = await env.rpc.FileJoinCommand(null as any, [
            "wsh://local//Users/mike/Documents",
            "../waveterm/docs",
            "preview-notes.md",
        ]);
        expect(joined.path).toBe("/Users/mike/waveterm/docs/preview-notes.md");
        expect(joined.mimetype).toBe("text/markdown");
    });

    it("implements secrets commands with in-memory storage", async () => {
        const { makeMockWaveEnv } = await import("./mockwaveenv");
        const env = makeMockWaveEnv({ platform: "linux" });

        await env.rpc.SetSecretsCommand(
            null as any,
            {
                OPENAI_API_KEY: "sk-test",
                ANTHROPIC_API_KEY: "anthropic-test",
            } as any
        );

        expect(await env.rpc.GetSecretsNamesCommand(null as any)).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

        await env.rpc.SetSecretsCommand(null as any, { OPENAI_API_KEY: null } as any);

        expect(await env.rpc.GetSecretsNamesCommand(null as any)).toEqual(["ANTHROPIC_API_KEY"]);
    });
});
