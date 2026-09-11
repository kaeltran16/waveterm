// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief header's autonomy chip, as a number. The mockup states the tier as one global fact
// ("Delegator · answers routine asks"), but the backend has no global tier: gatekeeper:enabled and
// delegator:enabled are per-channel meta (pkg/jarvis/resolve.go), and ResolveGatekeeperChannel gates on
// the channel the work belongs to. So the header can only summarize, and this is the summary — one tier
// when every project agrees, and an honest "mixed" when they do not, naming the highest tier in force
// because that is the one acting without you.

import { partitionChannels } from "@/app/view/agents/channelderive";
import { tierFromMeta, type JarvisTier } from "@/app/view/agents/channelmessages";
import { LADDER } from "./autonomyladder";

export interface ChannelAutonomy {
    channelId: string;
    name: string;
    tier: JarvisTier;
    mode: string;
}

// what the tier means for the queue, in the mockup's own words. The ladder's blurbs say what a tier
// includes; these say what it costs you, which is the thing a one-line chip has room for.
const CONSEQUENCE: Record<JarvisTier, string> = {
    concierge: "asks you everything",
    gatekeeper: "holds every gate",
    delegator: "answers routine asks",
};

const RANK: Record<JarvisTier, number> = { concierge: 0, gatekeeper: 1, delegator: 2 };

function tierLabel(tier: JarvisTier): string {
    return LADDER.find((r) => r.tier === tier)?.label ?? tier;
}

/** Pure: the per-project autonomy rows behind the chip. Archived channels are not work you have a
 *  policy over, so they are excluded; name order keeps the picker stable across refreshes. */
export function channelAutonomy(channels: Channel[] | null | undefined): ChannelAutonomy[] {
    const active = partitionChannels(channels ?? []).active;
    return active
        .map((c) => {
            const meta = c.meta as Record<string, unknown> | undefined;
            return {
                channelId: c.oid,
                name: c.name ?? c.oid,
                tier: tierFromMeta(meta),
                mode: typeof meta?.["delegator:mode"] === "string" ? (meta["delegator:mode"] as string) : "",
            };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface AutonomySummary {
    label: string;
    // the tier the chip's glyph draws: the shared one, or the highest in force when they disagree
    tier: JarvisTier;
    mixed: boolean;
}

/** Pure: the chip's face. Null for no projects — a policy chip over nothing to have a policy about
 *  would be the same lie as "all clear" over a snapshot that has not landed. */
export function autonomySummary(rows: ChannelAutonomy[]): AutonomySummary | null {
    if (rows.length === 0) {
        return null;
    }
    const top = rows.reduce((a, r) => (RANK[r.tier] > RANK[a] ? r.tier : a), rows[0].tier);
    const atTop = rows.filter((r) => r.tier === top).length;
    if (atTop === rows.length) {
        return { label: `${tierLabel(top)} · ${CONSEQUENCE[top]}`, tier: top, mixed: false };
    }
    return { label: `Mixed · ${atTop} of ${rows.length} ${tierLabel(top).toLowerCase()}`, tier: top, mixed: true };
}
