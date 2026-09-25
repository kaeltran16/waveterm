// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import settingsJson from "../../../pkg/wconfig/defaultconfig/settings.json";

export const DefaultFullConfig: FullConfigType = {
    settings: settingsJson as SettingsType,
    // the preview has no home-directory overrides, so the merged settings are the defaults
    defaultsettings: settingsJson as SettingsType,
    connections: {},
    projects: {},
    configerrors: [],
    version: "",
    buildtime: "",
};
