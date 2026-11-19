// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package boarddrawer is a board's drawer: the read-only claude session that takes each line asked on a board and
// either changes its drawing or flags it as a question for the board's agent, never answering in words. It is resumed
// turn after turn so it remembers the talk, and is handed what the board's agent said since it last read it. It runs
// one turn at a time per board, checks and routes every answer in code, and reaches the board files, the talk and
// the forwarder only through Deps.
package boarddrawer
