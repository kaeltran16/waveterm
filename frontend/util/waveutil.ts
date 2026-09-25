// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0s

export function formatRemoteUri(path: string, connection: string): string {
    connection = connection ?? "local";
    return `wsh://${connection}/${path}`;
}
