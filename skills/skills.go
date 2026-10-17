// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package skills holds the skills Arc ships. Each top-level directory is one skill tree; agentsync
// seeds them into the vault's skills root on every sync, so this directory is their only source.
// `task sync:claudemod` also copies them into the arc Claude Code plugin, which names them arc:<skill>.
package skills

import "embed"

//go:embed brainstorm cockpit design initiatives notes runs
var FS embed.FS
