// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "../agents/agents";
import { pendingSettingsSectionAtom } from "../agents/settingsstore";
import { landOn } from "./returnsurface";

// every "Connect Jira" / "Settings > Jira" link lands here
export function openJiraSettings(model: AgentsViewModel): void {
    globalStore.set(pendingSettingsSectionAtom, "jira");
    landOn(model.surfaceAtom, "settings");
}
