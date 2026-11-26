// Scenario `transcript-subagents-view`: a subagent opened in the center as a full-size, read-only transcript under
// its banner. Arranged over the transcript-subagents fixture (transcript-subagents-fixture.mjs) with the parent
// working; teardown removes it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    arrangeSubagentsAgent,
    teardownSubagentsAgent,
    writeSubagentsFixture,
} from "./transcript-subagents-fixture.mjs";

const NAME = "transcript-subagents-view";

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = { dir: mkdtempSync(join(tmpdir(), "verify-ts-view-")) };
                // a throw past this point still returns ctx, so teardown undoes whatever was already set
                try {
                    Object.assign(ctx, writeSubagentsFixture(ctx.dir, { turnEnded: false }));
                    await arrangeSubagentsAgent(h, ctx, { state: "working" });
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
