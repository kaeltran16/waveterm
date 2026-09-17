// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY seams for the resource-linking CDP scenario, installed by BriefSurface and never imported in a
// production build. A citation chip exists only after a live synthesis, so __seedBriefCitations puts one
// answered exchange on the Brief's thread with grounding the scenario supplies — the chip click under test is
// still the real one. __openAddress reaches the one case no chip can: an address the parser rejects renders as
// plain text.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { briefThreadAtom } from "./briefingstore";
import type { GroundingCard } from "./jarviscontract";
import { openAddress } from "./openref";

const SEEDED_PROSE = "Seeded for verification.";

export function installLinkingDevHooks(model: AgentsViewModel): void {
    const w = window as unknown as {
        __seedBriefCitations?: (cards: GroundingCard[]) => void;
        __openAddress?: (address: string) => Promise<unknown>;
    };
    w.__seedBriefCitations = (cards) => {
        const ts = Date.now();
        globalStore.set(briefThreadAtom, [
            { key: `dev-cite-q:${ts}`, ts, turn: { role: "user", text: "Seeded citations", attachments: [] } },
            {
                key: `dev-cite-a:${ts}`,
                ts,
                turn: {
                    role: "jarvis",
                    workingSteps: [],
                    segments: [{ text: SEEDED_PROSE }],
                    grounding: cards,
                    terminal: "answered",
                },
                answer: { answer: SEEDED_PROSE, grounding: cards, terminal: "answered" },
            },
        ]);
    };
    w.__openAddress = (address) => openAddress(model, address);
}
