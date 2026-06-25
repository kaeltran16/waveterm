// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The cockpit hosts tiling-block views (agents, term) standalone, outside the layout tree that
// normally supplies a BlockNodeModel. These views read only isFocused/isMagnified/focusNode/
// toggleMagnify, so a synthetic model with a focused-true atom and no-op handlers is sufficient.
import { BlockNodeModel } from "@/app/block/blocktypes";
import { atom } from "jotai";

export function makeSyntheticNodeModel(blockId: string): BlockNodeModel {
    return {
        blockId,
        isFocused: atom(true),
        isMagnified: atom(false),
        onClose: () => {},
        focusNode: () => {},
        toggleMagnify: () => {},
    };
}
