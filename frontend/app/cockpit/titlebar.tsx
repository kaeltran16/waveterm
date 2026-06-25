// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { getCurrentWindow } from "@tauri-apps/api/window";

// drag + window controls via Tauri core window plugin (perms granted in Phase 2 capabilities).
export function CockpitTitlebar() {
    const win = getCurrentWindow();
    return (
        <div className="cockpit-titlebar" data-tauri-drag-region>
            <div className="cockpit-titlebar-title" data-tauri-drag-region>
                Wave
            </div>
            <div className="cockpit-titlebar-controls">
                <button className="cockpit-tb-btn" onClick={() => win.minimize()} aria-label="Minimize">
                    &#x2013;
                </button>
                <button className="cockpit-tb-btn" onClick={() => win.toggleMaximize()} aria-label="Maximize">
                    &#x25A1;
                </button>
                <button className="cockpit-tb-btn cockpit-tb-close" onClick={() => win.close()} aria-label="Close">
                    &#x2715;
                </button>
            </div>
        </div>
    );
}
