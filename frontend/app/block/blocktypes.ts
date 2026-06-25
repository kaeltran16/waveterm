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

export type FullSubBlockProps = {
    nodeModel: BlockNodeModel;
    viewModel: ViewModel;
};

export interface SubBlockProps {
    nodeModel: BlockNodeModel;
}

export interface BlockComponentModel2 {
    onClick?: () => void;
    onPointerEnter?: React.PointerEventHandler<HTMLDivElement>;
    onFocusCapture?: React.FocusEventHandler<HTMLDivElement>;
    blockRef?: React.RefObject<HTMLDivElement>;
}
