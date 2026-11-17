// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const agentPrompt = vi.fn();
const controllerInput = vi.fn();
const agentBash = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        AgentPromptCommand: (...a: any[]) => agentPrompt(...a),
        ControllerInputCommand: (...a: any[]) => controllerInput(...a),
        AgentBashCommand: (...a: any[]) => agentBash(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { toastsAtom } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { sendAgentBash, sendAgentText, sendTypedText, toastSendFailure } from "./agentsend";

beforeEach(() => {
    agentPrompt.mockReset();
    agentPrompt.mockResolvedValue(undefined);
    controllerInput.mockReset();
    agentBash.mockReset();
    agentBash.mockResolvedValue(undefined);
});

describe("sendAgentText", () => {
    it("sends a 120-character message as one AgentPromptCommand", async () => {
        const text = "x".repeat(120);
        await sendAgentText("blk-1", text);
        expect(agentPrompt).toHaveBeenCalledTimes(1);
        expect(agentPrompt.mock.calls[0][1]).toEqual({ blockid: "blk-1", text });
    });

    it("trims whitespace and keeps embedded newlines", async () => {
        await sendAgentText("blk-1", "  \n first line\nsecond line\n\n  ");
        expect(agentPrompt.mock.calls[0][1]).toEqual({ blockid: "blk-1", text: "first line\nsecond line" });
    });

    it("never calls ControllerInputCommand", async () => {
        await sendAgentText("blk-1", "hello");
        expect(controllerInput).not.toHaveBeenCalled();
    });

    it("rejects on empty text", async () => {
        await expect(sendAgentText("blk-1", "   \n ")).rejects.toThrow(/blk-1/);
        expect(agentPrompt).not.toHaveBeenCalled();
    });

    it("rejects with the block id when the RPC fails", async () => {
        agentPrompt.mockRejectedValue(new Error("no route"));
        await expect(sendAgentText("blk-9", "hello")).rejects.toThrow(/blk-9.*no route/);
    });
});

describe("sendTypedText", () => {
    it("sends the trimmed text as the person's own prompt, to be typed into the terminal", async () => {
        await sendTypedText("blk-1", "  wait, use the other file \n");
        expect(agentPrompt).toHaveBeenCalledTimes(1);
        expect(agentPrompt.mock.calls[0][1]).toEqual({
            blockid: "blk-1",
            text: "wait, use the other file",
            person: true,
        });
    });

    it("rejects on empty text and names the block when the RPC fails", async () => {
        await expect(sendTypedText("blk-1", " ")).rejects.toThrow(/blk-1/);
        agentPrompt.mockRejectedValue(new Error("no route"));
        await expect(sendTypedText("blk-9", "hello")).rejects.toThrow(/blk-9.*no route/);
    });
});

describe("sendAgentBash", () => {
    it("sends the trimmed command as one AgentBashCommand, never as a prompt", async () => {
        await sendAgentBash("blk-1", "  echo hi \n");
        expect(agentBash).toHaveBeenCalledTimes(1);
        expect(agentBash.mock.calls[0][1]).toEqual({ blockid: "blk-1", command: "echo hi" });
        expect(agentPrompt).not.toHaveBeenCalled();
        expect(controllerInput).not.toHaveBeenCalled();
    });

    it("rejects on a blank command", async () => {
        await expect(sendAgentBash("blk-1", "  ")).rejects.toThrow(/blk-1/);
        expect(agentBash).not.toHaveBeenCalled();
    });

    it("rejects with the block id and the refusal when the RPC fails", async () => {
        agentBash.mockRejectedValue(new Error("block blk-9 has no running shell: nothing was run"));
        await expect(sendAgentBash("blk-9", "ls")).rejects.toThrow(/blk-9.*nothing was run/);
    });
});

describe("toastSendFailure", () => {
    it("raises one error toast with the refusal's own words, so a refused send never reads as sent", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        globalStore.set(toastsAtom, []);
        agentPrompt.mockRejectedValue(new Error("block blk-1 has no live terminal: nothing was sent"));
        await sendAgentText("blk-1", "/model opus").catch((e) => toastSendFailure("Model not changed", e));
        expect(globalStore.get(toastsAtom)).toMatchObject([
            {
                level: "error",
                title: "Model not changed",
                message: "send to block blk-1: block blk-1 has no live terminal: nothing was sent",
            },
        ]);
        err.mockRestore();
    });
});
