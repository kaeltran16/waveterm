// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of starting a run from the Brief header. A project is the only thing the user names: the
// channel a run needs is storage (CreateRunCommand requires a channelid, and copies the worker cwd and the
// resolved profile off it), so it is resolved by path or minted on the spot rather than created by hand.
// That is why this is a decision and not a create call — a create call cannot be unit-tested, and getting
// "does this project already have a channel" wrong is how you end up with the duplicates we are removing.

import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { profileRunDefaults } from "@/app/view/agents/runconfig";

export type ChannelTarget = { kind: "existing"; oid: string } | { kind: "create"; name: string; path: string };

// Null means the channel list has not arrived. That is not the same as "this project has no channel", and
// the difference is load-bearing: minting one on an unread list creates a duplicate of a channel we simply
// could not see yet, which is the exact state this modal exists to stop producing.
export function resolveChannelTarget(
    channels: Channel[] | null,
    projectName: string,
    projectPath: string
): ChannelTarget | null {
    if (channels == null) {
        return null;
    }
    const existing = resolveTargetChannel(channels, projectPath);
    if (existing != null) {
        return { kind: "existing", oid: existing.oid };
    }
    // named after the project, because the project is the only name for it a user will ever see
    return { kind: "create", name: projectName, path: projectPath };
}

export interface LaunchOpts {
    mode: string;
    orchestration?: string;
    parallelism?: number;
    workerRoute?: RoutePin;
}

// The launch a project's profile already describes, as CreateRun's arguments. The header modal offers no
// run configuration — the sheet's launcher owns that — but it cannot simply omit the mode: the server reads
// an unset mode as `quick` (resolveRunPlan), so a project whose profile says `pipeline` would silently get
// a quick run. Sending the profile's own answer is what makes "it uses the project's settings" true.
export function launchOptsFromProfile(profile: JarvisProfile | null | undefined): LaunchOpts {
    const defaults = profileRunDefaults(profile);
    const mode = defaults.shape ?? "quick";
    if (mode !== "orchestrator") {
        return { mode };
    }
    // the machine, the width and the worker route are read only on an orchestrator launch (runLauncherFace)
    return {
        mode,
        ...(defaults.orchestration != null ? { orchestration: defaults.orchestration } : {}),
        ...(defaults.parallelism != null ? { parallelism: defaults.parallelism } : {}),
        ...(defaults.workerRoute != null ? { workerRoute: defaults.workerRoute } : {}),
    };
}
