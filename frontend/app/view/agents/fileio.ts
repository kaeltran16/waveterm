// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The agent views' file primitives over wavesrv: a leaf, so the pollers and the senders share them without importing
// each other.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { arrayToBase64, makeConnRoute } from "@/util/util";

export type FileIO = {
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<string[]>;
    write(path: string, bytes: Uint8Array): Promise<void>;
};

export const tauriFileIO: FileIO = {
    // FileMkdirCommand fails on a directory that already exists
    async mkdir(path) {
        const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path } });
        if (info != null && !info.notfound) {
            if (!info.isdir) {
                throw new Error(`${path} is a file`);
            }
            return;
        }
        await RpcApi.FileMkdirCommand(TabRpcClient, { info: { path } });
    },
    // FileReadCommand on a directory returns its info but no entries
    async list(path) {
        const names: string[] = [];
        const gen = RpcApi.RemoteListEntriesCommand(TabRpcClient, { path }, { route: makeConnRoute(null) });
        for await (const chunk of gen) {
            names.push(...(chunk.fileinfo ?? []).map((f) => f.name ?? ""));
        }
        return names;
    },
    async write(path, bytes) {
        await RpcApi.FileWriteCommand(TabRpcClient, { info: { path }, data64: arrayToBase64(bytes) });
    },
};
