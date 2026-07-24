# Vendored `sqlite3.h`

`sqlite3.h` here is a verbatim copy of `sqlite3-binding.h` from the pinned
`github.com/mattn/go-sqlite3` module (v1.14.40 — the amalgamation's public
SQLite C API header).

## Why it exists

`github.com/asg017/sqlite-vec-go-bindings/cgo` compiles `sqlite-vec.c` with
`#include "sqlite3.h"`. mattn ships that same header under the name
`sqlite3-binding.h`, so `sqlite3.h` is unresolvable on the default include path.
CGO `#cgo CFLAGS` set in *our* Go package do not propagate to an imported cgo
module's compilation, so the fix must come from the global `CGO_CFLAGS`
pointing at a directory that contains a file literally named `sqlite3.h`.

## How it's wired

Any build or test that compiles `pkg/jarvisembed` (i.e. links sqlite-vec) must set:

    CGO_CFLAGS="-O2 -g -I<repo>/pkg/jarvisembed/csrc"

`-O2` (the CGO default) must be preserved: without it, zig's Debug default turns
on `-fsanitize=undefined` for `sqlite-vec.c` and the link fails on unresolved
`__ubsan_handle_*` symbols. mattn avoids this because its own cgo directives pass
`-O2`; the asg017 module does not.

`sqlite_vec.Auto()` links under Wave's `sqlite_omit_load_extension` build tag
because `sqlite3_auto_extension` is compiled unconditionally (it is not guarded
by `SQLITE_OMIT_LOAD_EXTENSION`).

## Keeping it in sync

If `github.com/mattn/go-sqlite3` is upgraded, re-copy the header:

    cp "$(go list -m -f '{{.Dir}}' github.com/mattn/go-sqlite3)/sqlite3-binding.h" \
       pkg/jarvisembed/csrc/sqlite3.h

The SQLite public C API is append-only and extremely stable, so drift is
low-risk, but the copy should track the linked driver version.
