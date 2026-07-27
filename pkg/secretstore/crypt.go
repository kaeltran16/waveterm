// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package secretstore

import "errors"

// protect/unprotect are the at-rest encryption seam for the secrets file, implemented per platform.
//
// These used to be an RPC round-trip to the Electron shell's safeStorage over wshutil.ElectronRoute.
// Under Tauri nothing serves that route (only senders exist — see the backend-legacy-cleanup plan), so
// every write failed and no secrets file was ever produced: secrets lived in wavesrv's memory and died
// with the process. Doing the encryption in-process removes the dead hop rather than reviving it, which
// is the same call the rest of the Tauri migration made.

// ErrPersistUnsupported is returned by protect/unprotect where no at-rest encryption is implemented.
// The store still works, in memory, for the lifetime of the process — the same graceful degradation
// callers already had, but with an honest error instead of a silent timeout.
var ErrPersistUnsupported = errors.New("secretstore: encrypted persistence is not implemented on this platform")
