// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The channel overview strip's on-demand Jarvis fleet summary. Streams JarvisCommand into local state
// (not autonomy-gated). Extracted from channelssurface.tsx.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useState } from "react";
import { type AgentVM } from "../agents/agentsviewmodel";
import { buildFleetSnapshot, buildJarvisPrompt } from "../agents/jarvisderive";

export type SummaryState = { status: "streaming" | "done" | "error"; text: string };

// A consult runs a headless CLI up to the backend's 120s timeout; give the stream headroom past it
// (the RPC layer's 5s default would kill the stream long before a reply lands).
const JARVIS_RPC_TIMEOUT_MS = 130_000;

export function useFleetSummary(): {
    summary: SummaryState | null;
    runSummary: (channel: Channel, agents: AgentVM[], focus?: string) => void;
    reset: () => void;
} {
    const [summary, setSummary] = useState<SummaryState | null>(null);
    const runSummary = (channel: Channel, agents: AgentVM[], focus = "") => {
        const snapshot = buildFleetSnapshot(channel, agents);
        if (snapshot.length === 0) {
            setSummary({ status: "done", text: "No workers dispatched in this channel yet." });
            return;
        }
        const prompt = buildJarvisPrompt(snapshot, channel, focus);
        const reqId = crypto.randomUUID();
        setSummary({ status: "streaming", text: "" });
        fireAndForget(async () => {
            try {
                const gen = RpcApi.JarvisCommand(
                    TabRpcClient,
                    { channelid: channel.oid, prompt, requestid: reqId },
                    { timeout: JARVIS_RPC_TIMEOUT_MS }
                );
                let acc = "";
                for await (const chunk of gen) {
                    acc += chunk?.text ?? "";
                    setSummary({ status: "streaming", text: acc });
                }
                setSummary({ status: "done", text: acc });
            } catch {
                setSummary((s) => ({ status: "error", text: s?.text ?? "" }));
            }
        });
    };
    return { summary, runSummary, reset: () => setSummary(null) };
}
