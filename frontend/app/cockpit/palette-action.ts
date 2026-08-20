// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type PaletteActionResult = { ok: true } | { ok: false; error: string };

export async function runPaletteAction(action: () => Promise<unknown>): Promise<PaletteActionResult> {
    try {
        await action();
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}
