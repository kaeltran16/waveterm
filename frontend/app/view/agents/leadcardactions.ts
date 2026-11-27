// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A run's worker parallelism, set from the run palette.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { settingsChangePayload } from "../jarvis/runsettings";
import type { RunInfo } from "./runlineage";

// SetRunSettings applies every dial it is sent, so the rest go as the dag holds them
export function setRunParallelism(
    run: Pick<RunInfo, "runId" | "channelId" | "dag">,
    parallelism: number
): Promise<void> {
    return RpcApi.SetRunSettingsCommand(
        TabRpcClient,
        settingsChangePayload(run.channelId, run.runId, null, run.dag ?? null, { parallelism })
    );
}
