// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY: one narration feed over fixture entries, so the narration-feed CDP scenario
// (scripts/cdp/narrationfeed.mjs) can check the rendered feed. Every real host of the feed needs a live
// session or run. Same seam shape as window.__waveDagModalFixture (view/orchestrate/dagmodalstate.ts).

import { ModalShell } from "@/app/modals/modalshell";
import { modalsModel } from "@/app/store/modalmodel";
import type { AgentEntry } from "./agentsviewmodel";
import { NarrationTimeline } from "./narrationtimeline";

export function NarrationFeedFixtureModal({ entries, width }: { entries: AgentEntry[]; width: number }) {
    return (
        <ModalShell open onClose={() => modalsModel.popModal()}>
            <div data-narration-fixture style={{ width }} className="max-h-[80vh] overflow-y-auto bg-surface px-3 py-2">
                <NarrationTimeline entries={entries} active={false} />
            </div>
        </ModalShell>
    );
}

if (import.meta.env.DEV && typeof window !== "undefined") {
    window.__narrationFeedFixture = {
        show: (entries, width) => modalsModel.pushModal("NarrationFeedFixtureModal", { entries, width }),
        clear: () => {
            while (modalsModel.hasOpenModals()) {
                modalsModel.popModal();
            }
        },
    };
}

declare global {
    interface Window {
        __narrationFeedFixture?: {
            show: (entries: AgentEntry[], width: number) => void;
            clear: () => void;
        };
    }
}
