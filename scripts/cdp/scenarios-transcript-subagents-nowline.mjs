// Scenario `transcript-subagents-nowline`: running background subagents in the parent's now line. Arranged over the
// transcript-subagents fixture (transcript-subagents-fixture.mjs) with the parent idle and its turn ended; teardown
// removes it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    arrangeSubagentsAgent,
    teardownSubagentsAgent,
    writeSubagentsFixture,
} from "./transcript-subagents-fixture.mjs";

const NAME = "transcript-subagents-nowline";

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = { dir: mkdtempSync(join(tmpdir(), "verify-ts-nowline-")) };
                // a throw past this point still returns ctx, so teardown undoes whatever was already set
                try {
                    Object.assign(ctx, writeSubagentsFixture(ctx.dir, { turnEnded: true }));
                    await arrangeSubagentsAgent(h, ctx, { state: "idle" });
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                if (ctx.arrangeError != null) {
                    return [{ step: "arrange the fixture agent", ok: false, detail: ctx.arrangeError }];
                }
                return [];
            },
            teardown: teardownSubagentsAgent,
        },
    ];
}
