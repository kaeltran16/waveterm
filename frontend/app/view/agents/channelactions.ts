// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Impure side of the Channels composer: turns a typed message into the right verb-command(s).
// dispatch -> launchAgent (a new worker) + a "dispatch" message; steer -> ControllerInputCommand
// (inject into a live worker's PTY) + a "directive" message; post -> a "human" message. Every branch
// records a channel message so the timeline is the single source of truth (and a manager can replay it).

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stringToBase64 } from "@/util/util";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { planMessage, type RosterEntry } from "./channelmessages";
import { activeChannelAtom, consultStreamKey, consultStreamsAtom, setConsultStream } from "./channelsstore";
import { buildFleetSnapshot, buildJarvisPrompt } from "./jarvisderive";
import { runtimeStartupCommand } from "./launch";

// A consult runs a headless CLI that can take up to the backend's 120s consultTimeout. The RPC layer
// otherwise applies a 5s default handler timeout (DefaultTimeoutMs), which would kill the stream long
// before the reply lands (codex emits its first reply chunk only at ~6s). Give it headroom past 120s.
const CONSULT_RPC_TIMEOUT_MS = 130_000;

async function post(channelId: string, kind: string, author: string, text: string, refORef: string): Promise<void> {
    await RpcApi.PostChannelMessageCommand(TabRpcClient, {
        channelid: channelId,
        kind,
        author,
        text,
        reforef: refORef,
    });
}

export async function sendChannelMessage(args: {
    model: AgentsViewModel;
    channelId: string;
    projectPath: string;
    projectName: string;
    roster: RosterEntry[];
    agents: AgentVM[];
    text: string;
}): Promise<void> {
    const { model, channelId, projectPath, projectName, roster, agents, text } = args;
    const plan = planMessage(text, roster);
    if (plan.kind === "jarvis") {
        const reqId = crypto.randomUUID();
        // anchor: the user's request, grouped to its reply by requestId (mirrors the consult grouping)
        await RpcApi.PostChannelMessageCommand(TabRpcClient, {
            channelid: channelId,
            kind: "jarvis",
            author: "you",
            text: plan.text || "summarize the fleet",
            reforef: `jarvis:${reqId}`,
        });
        const channel = globalStore.get(activeChannelAtom);
        const snapshot = channel ? buildFleetSnapshot(channel, agents) : [];
        if (snapshot.length === 0) {
            // nothing dispatched here — answer without spending a model call
            await post(channelId, "jarvis-reply", "jarvis", "No workers dispatched in this channel yet.", `jarvis:${reqId}`);
            return;
        }
        const prompt = buildJarvisPrompt(snapshot, channel!, plan.text);
        setConsultStream(reqId, "jarvis", { text: "", status: "streaming" });
        try {
            const gen = RpcApi.JarvisCommand(
                TabRpcClient,
                { channelid: channelId, prompt, requestid: reqId },
                { timeout: CONSULT_RPC_TIMEOUT_MS }
            );
            let acc = "";
            for await (const chunk of gen) {
                acc += chunk?.text ?? "";
                setConsultStream(reqId, "jarvis", { text: acc, status: "streaming" });
            }
            setConsultStream(reqId, "jarvis", { text: acc, status: "done" });
        } catch {
            // the backend still posts a jarvis-reply with the error; mark the live row done
            setConsultStream(reqId, "jarvis", {
                text: globalStore.get(consultStreamsAtom)[consultStreamKey(reqId, "jarvis")]?.text ?? "",
                status: "error",
            });
        }
        return;
    }
    if (plan.kind === "consult") {
        const consultId = crypto.randomUUID();
        // one question row (author "you"), grouped to its replies by the shared consultId
        await RpcApi.PostChannelMessageCommand(TabRpcClient, {
            channelid: channelId,
            kind: "consult",
            author: "you",
            text: plan.text,
            reforef: `consult:${consultId}`,
        });
        // fan out: one streaming consult per runtime, accumulating into the ephemeral atom
        await Promise.all(
            plan.runtimes.map(async (runtime) => {
                setConsultStream(consultId, runtime, { text: "", status: "streaming" });
                try {
                    const gen = RpcApi.ConsultCommand(
                        TabRpcClient,
                        {
                            channelid: channelId,
                            runtime,
                            prompt: plan.text,
                            consultid: consultId,
                        },
                        { timeout: CONSULT_RPC_TIMEOUT_MS }
                    );
                    let acc = "";
                    for await (const chunk of gen) {
                        acc += chunk?.text ?? "";
                        setConsultStream(consultId, runtime, { text: acc, status: "streaming" });
                    }
                    setConsultStream(consultId, runtime, { text: acc, status: "done" });
                } catch {
                    // the backend still posts a consult-reply with the error; mark the live row done
                    setConsultStream(consultId, runtime, {
                        text: globalStore.get(consultStreamsAtom)[consultStreamKey(consultId, runtime)]?.text ?? "",
                        status: "error",
                    });
                }
            })
        );
        return;
    }
    if (plan.kind === "dispatch") {
        const tabId = await launchAgent(model, {
            runtime: plan.runtime,
            startupCommand: runtimeStartupCommand(plan.runtime),
            task: plan.text,
            projectPath,
            projectName: projectName || "agent",
        });
        await post(channelId, "dispatch", plan.runtime, plan.text, `tab:${tabId}`);
        return;
    }
    if (plan.kind === "steer") {
        if (plan.blockId) {
            await RpcApi.ControllerInputCommand(TabRpcClient, {
                blockid: plan.blockId,
                inputdata64: stringToBase64(plan.text + "\r"),
            });
        }
        await post(channelId, "directive", "you", plan.text, `tab:${plan.targetId}`);
        return;
    }
    await post(channelId, "human", "you", plan.text, "");
}
