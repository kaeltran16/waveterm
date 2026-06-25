// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { buildTauriMenu } from "../../tauri/menu";

type ShowContextMenuOpts = {
    onSelect?: (item: ContextMenuItem) => void;
    onCancel?: () => void;
    onClose?: (item: ContextMenuItem | null) => void;
};

class ContextMenuModel {
    private static instance: ContextMenuModel;

    private constructor() {}

    static getInstance(): ContextMenuModel {
        if (ContextMenuModel.instance == null) {
            ContextMenuModel.instance = new ContextMenuModel();
        }
        return ContextMenuModel.instance;
    }

    showContextMenu(menu: ContextMenuItem[], ev: React.MouseEvent<any>, _opts?: ShowContextMenuOpts): void {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        fireAndForget(async () => {
            const m = await buildTauriMenu(menu);
            await m.popup();
        });
    }
}

export { ContextMenuModel };
