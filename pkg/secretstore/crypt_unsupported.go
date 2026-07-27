// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package secretstore

// Tauri packaging is Windows-only today (see CLAUDE.md), and the shell-side keyring that used to serve
// macOS/Linux is gone with Electron. Rather than ship an untested keyring integration, these report
// unsupported: the store degrades to in-memory, which is exactly what every platform does today.

func protect(_ []byte) ([]byte, error) { return nil, ErrPersistUnsupported }

func unprotect(_ []byte) ([]byte, error) { return nil, ErrPersistUnsupported }
