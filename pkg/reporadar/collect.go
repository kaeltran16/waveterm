// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

// collectInput is the scope a collector reads: the canonical project path and the evidence-window
// lower bound (0 = full first-scan window; else "since this UnixMilli").
type collectInput struct {
	projectPath string
	sinceTs     int64
}
