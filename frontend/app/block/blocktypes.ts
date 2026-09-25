// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Atom } from "jotai";

export interface BlockNodeModel {
    blockId: string;
    isFocused: Atom<boolean>;
    isMagnified: Atom<boolean>;
    onClose: () => void;
    focusNode: () => void;
    toggleMagnify: () => void;
}
