// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package boarddrawer is a board's drawer: the read-only claude session that answers each question asked on a board
// with a few words and changes to its drawing, resumed turn after turn so it remembers the talk. It runs one turn at
// a time per board, checks every answer in code, and reaches the board files and the talk only through Deps.
package boarddrawer
