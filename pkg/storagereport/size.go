// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
)

// a junction reads as ModeIrregular, not ModeSymlink
const linkModes = fs.ModeSymlink | fs.ModeIrregular

// pathSize is the bytes under path and its newest mtime (ms), its own included. Junctions and symlinks count as 0
// and are never followed. A file that vanishes during the walk is skipped.
func pathSize(ctx context.Context, path string) (size int64, modTs int64, err error) {
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			if p != path && errors.Is(werr, fs.ErrNotExist) {
				return nil
			}
			return werr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.Type()&linkModes != 0 {
			return nil
		}
		info, ierr := d.Info()
		if errors.Is(ierr, fs.ErrNotExist) {
			return nil
		}
		if ierr != nil {
			return ierr
		}
		if !d.IsDir() {
			size += info.Size()
		}
		modTs = max(modTs, info.ModTime().UnixMilli())
		return nil
	})
	return size, modTs, err
}
