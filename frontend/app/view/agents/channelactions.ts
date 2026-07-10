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
import { planDelegate, planMessage, tierFromMeta, type RosterEntry } from "./channelmessages";
import { activeChannelAtom, consultStreamKey, consultStreamsAtom, setConsultStream } from "./channelsstore";
import { buildFleetSnapshot, buildJarvisPrompt } from "./jarvisderive";
import { composeStartupCommand, deriveBranch, runtimeStartupCommand, type Runtime } from "./launch";
import { naFlagsAtom } from "./naflagsstore";

// A consult runs a headless CLI that can take up to the backend's 120s consultTimeout. The RPC layer
// otherwise applies a 5s default handler timeout (DefaultTimeoutMs), which would kill the stream long
// before the reply lands (codex emits its first reply chunk only at ~6s). Give it headroom past 120s.
const CONSULT_RPC_TIMEOUT_MS = 130_000;

// Apply the user's persisted per-runtime launch flags (New Agent modal / Settings) so a channel
// dispatch honors the same flags as a manual launch, instead of a bare startup command.
function flaggedStartup(runtime: Runtime): string {
    const flags = globalStore.get(naFlagsAtom)[runtime] ?? {};
    return composeStartupCommand(runtimeStartupCommand(runtime), runtime, flags);
}

async function post(channelId: string, kind: string, author: string, text: string, refORef: string): Promise<void> {
    await RpcApi.PostChannelMessageCommand(TabRpcClient, {
        channelid: channelId,
        kind,
        author,
        text,
        reforef: refORef,
    });
}

// Dismiss a finished ("gone") worker from a channel's fleet panel by posting a dismiss message; the
// snapshot subtracts it (a later re-dispatch of the same oref supersedes the dismiss). Fire-and-forget.
export async function dismissWorker(channelId: string, workerORef: string): Promise<void> {
    await post(channelId, "dismiss", "you", "", workerORef);
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
        const channel = globalStore.get(activeChannelAtom);
        // delegator-tier channels turn an @jarvis goal into a real worker dispatch; other tiers fall
        // through to the observe-only summary below. The "dispatch" message's tab: oref is what the
        // Gatekeeper watcher matches to auto-answer this worker's routine asks (Manage mode).
        const tier = tierFromMeta(channel?.meta as Record<string, unknown> | undefined);
        const defaultMode = ((channel?.meta as Record<string, unknown>)?.["delegator:mode"] as
            | "report"
            | "manage"
            | "fanout") ?? "report";
        const del = planDelegate({ tier, defaultMode, override: plan.mode, goal: plan.text });
        if (del.action === "dispatch") {
            if (del.mode === "fanout") {
                const { subtasks } = await RpcApi.JarvisDecomposeCommand(
                    TabRpcClient,
                    { channelid: channelId, goal: plan.text },
                    { timeout: CONSULT_RPC_TIMEOUT_MS }
                );
                let existing: string[] = [];
                try {
                    const br = await RpcApi.ListBranchesCommand(TabRpcClient, { projectpath: projectPath });
                    existing = (br.branches ?? []).map((b) => b.name);
                } catch {
                    // no git / listing failed — deriveBranch still yields unique names off an empty set
                }
                const base = projectName || "agent";
                for (let i = 0; i < subtasks.length; i++) {
                    const branch = deriveBranch(`${base}-${i + 1}`, existing);
                    existing.push(branch);
                    const task = `/goal ${subtasks[i]}`;
                    const tabId = await launchAgent(model, {
                        runtime: "claude",
                        startupCommand: flaggedStartup("claude"),
                        task,
                        projectPath,
                        projectName: `${base}-${i + 1}`,
                        branch,
                    });
                    await post(channelId, "dispatch", "claude", task, `tab:${tabId}`);
                }
                return;
            }
            const tabId = await launchAgent(model, {
                runtime: "claude",
                startupCommand: flaggedStartup("claude"),
                task: del.task,
                projectPath,
                projectName: projectName || "agent",
            });
            await post(channelId, "dispatch", "claude", del.task, `tab:${tabId}`);
            return;
        }
        const reqId = crypto.randomUUID();
        // anchor: the user's request, grouped to its reply by requestId (mirrors the consult grouping)
        await RpcApi.PostChannelMessageCommand(TabRpcClient, {
            channelid: channelId,
            kind: "jarvis",
            author: "you",
            text: plan.text || "summarize the fleet",
            reforef: `jarvis:${reqId}`,
        });
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
            startupCommand: flaggedStartup(plan.runtime),
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

// steerWorker injects a directive into a live worker's terminal (Override on an answered card) and
// records a directive message, mirroring the composer's steer branch. workerORef is a "tab:<id>" oref;
// the roster entry supplies the blockId to write to. No-ops (returns false) if the worker is gone.
export async function steerWorker(args: {
    channelId: string;
    workerORef: string;
    agents: AgentVM[];
    text: string;
}): Promise<boolean> {
    const { channelId, workerORef, agents, text } = args;
    if (!workerORef.startsWith("tab:")) {
        return false;
    }
    const worker = agents.find((a) => a.id === workerORef.slice("tab:".length));
    if (!worker?.blockId) {
        return false;
    }
    await RpcApi.ControllerInputCommand(TabRpcClient, {
        blockid: worker.blockId,
        inputdata64: stringToBase64(text + "\r"),
    });
    await post(channelId, "directive", "you", text, workerORef);
    return true;
}
