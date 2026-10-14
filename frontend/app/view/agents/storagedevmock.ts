// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY Storage fixtures for CDP visual verification. setStorageScenario(name) is exposed on window in dev
// (see settingssurface.tsx) so CDP can render each state of the Storage section without a real scan, and
// without any action reaching wavesrv: in fixture mode every action is only recorded (storagestore.ts).

import { STORAGE_SCENARIOS, type StorageScenario } from "./storagefixtures";
import { clearStorageFixture, loadStorage, setStorageFixture } from "./storagestore";

export function setStorageScenario(name: string): void {
    if (name === "live") {
        clearStorageFixture();
        void loadStorage();
        return;
    }
    const r = STORAGE_SCENARIOS[name as StorageScenario];
    if (r == null) {
        throw new Error(
            `unknown storage scenario "${name}"; one of live, ${Object.keys(STORAGE_SCENARIOS).join(", ")}`
        );
    }
    setStorageFixture(r);
}
