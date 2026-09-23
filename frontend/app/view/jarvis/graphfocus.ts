// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which object the graph peek opens on. The peek's contract is that you enter it *from* an object, so
// arriving on the whole vault with nothing selected breaks it: 432 nodes and no way in but hunting.

// A run node exists in the graph only inside its record's attribution bloom (VaultGraph emits no runs), so
// focusing a run means naming the record to bloom *and* the run to select once that bloom lands.
export interface PeekFocus {
    dossierId: string | null;
    runORef: string | null;
}
