// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Impure side of the Channels composer: turns a typed message into the right verb-command(s).
// dispatch -> launchAgent (a new worker) + a "dispatch" message; steer -> ControllerInputCommand
// (inject into a live worker's PTY) + a "directive" message; post -> a "human" message. Every branch
// records a channel message so the timeline is the single source of truth (and a manager can replay it).

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stringToBase64 } from "@/util/util";
import type { AgentsViewModel } from "./agents";
import { planMessage, type RosterEntry } from "./channelmessages";
import { runtimeStartupCommand } from "./launch";

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
    text: string;
}): Promise<void> {
    const { model, channelId, projectPath, projectName, roster, text } = args;
    const plan = planMessage(text, roster);
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
