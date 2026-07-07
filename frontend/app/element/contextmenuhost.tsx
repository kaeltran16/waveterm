// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenu } from "@/app/element/contextmenu";
import { contextMenuAtom } from "@/app/store/contextmenu";
import { useAtomValue } from "jotai";

export function ContextMenuHost() {
    const state = useAtomValue(contextMenuAtom);
    if (state == null) {
        return null;
    }
    return <ContextMenu state={state} />;
}
