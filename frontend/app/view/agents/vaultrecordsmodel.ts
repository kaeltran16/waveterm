// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view-model logic for the Vault Records split ledger. No React or Wave runtime imports.

export const RECORD_STATUS_ORDER = ["active", "paused", "completed", "archived"] as const;

export interface VaultRecordGroup {
    status: (typeof RECORD_STATUS_ORDER)[number];
    label: string;
    rows: SpaceSummary[];
}

const RECORD_STATUS_LABELS: Record<VaultRecordGroup["status"], string> = {
    active: "Active",
    paused: "Paused",
    completed: "Completed",
    archived: "Archived",
};

export function buildVaultRecordGroups(records: SpaceSummary[], query: string): VaultRecordGroup[] {
    const needle = query.trim().toLowerCase();
    const visible =
        needle === ""
            ? records
            : records.filter((record) =>
                  `${record.objective} ${record.ticket} ${record.status}`.toLowerCase().includes(needle)
              );

    return RECORD_STATUS_ORDER.map((status) => ({
        status,
        label: RECORD_STATUS_LABELS[status],
        rows: visible.filter((record) => record.status === status),
    })).filter((group) => group.rows.length > 0);
}

export function resolveVaultRecordId(groups: VaultRecordGroup[], selectedId: string | null): string | undefined {
    if (selectedId != null && groups.some((group) => group.rows.some((record) => record.id === selectedId))) {
        return selectedId;
    }
    return groups[0]?.rows[0]?.id;
}

function timelineLabel(label: string, timestamp: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return `${label} unknown`;
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return `${label} unknown`;
    }
    return `${label} ${date.toISOString().slice(0, 10)}`;
}

// Counts per status, in ledger order, with empty groups omitted — the collection line lists only what is
// actually there. Shares RECORD_STATUS_ORDER with the index groups so the two can never disagree on the
// vocabulary or its order.
export function recordStatusCounts(records: SpaceSummary[]): { status: VaultRecordGroup["status"]; count: number }[] {
    return buildVaultRecordGroups(records, "").map((group) => ({ status: group.status, count: group.rows.length }));
}

export function recordTimelineMeta(detail: DossierDetail): { created: string; updated: string } {
    return {
        created: timelineLabel("Created", detail.created),
        updated: timelineLabel("Updated", detail.updated),
    };
}
