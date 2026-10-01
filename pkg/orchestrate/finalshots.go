// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// shotsManifestName is the optional manifest a Final command writes into ARC_FINAL_OUT: a JSON array of
// waveobj.FinalShot.
const shotsManifestName = "shots.json"

// maxShotsManifestBytes bounds shots.json: the manifest is stored on the dag, which every update rewrites.
const maxShotsManifestBytes = 1 << 20

// FinalShotsRetention is how long a round's ARC_FINAL_OUT stays on disk.
const FinalShotsRetention = 30 * 24 * time.Hour

// finalShotsRoot holds every dag's ARC_FINAL_OUT dirs, as <root>/<dag>/<round>. A var so tests can move it.
var finalShotsRoot = func() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "final-shots")
}

var shotStepStates = []string{"pass", "fail", "skip"}

var driveLetterRe = regexp.MustCompile(`^[A-Za-z]:`)

// readFinalShots reads what the Final command left in outDir: its shots.json when it wrote a valid one
// (manifest true), else every PNG under outDir as one shot each. A manifest that cannot be used falls back to the
// listing, with the reason logged, so a bad manifest never changes the stage's outcome.
func readFinalShots(dagID, outDir string) ([]waveobj.FinalShot, bool) {
	shots, err := readShotsManifest(dagID, outDir)
	if err == nil {
		return shots, true
	}
	if !errors.Is(err, fs.ErrNotExist) {
		log.Printf("dag %s: reading %s: %v", dagID, shotsManifestName, err)
	}
	return listFinalShots(dagID, outDir), false
}

func readShotsManifest(dagID, outDir string) ([]waveobj.FinalShot, error) {
	file, err := os.Open(filepath.Join(outDir, shotsManifestName))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxShotsManifestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxShotsManifestBytes {
		return nil, fmt.Errorf("it is over %d bytes", maxShotsManifestBytes)
	}
	var shots []waveobj.FinalShot
	if err := json.Unmarshal(data, &shots); err != nil {
		return nil, err
	}
	for i := range shots {
		for _, st := range shots[i].Steps {
			if !slices.Contains(shotStepStates, st.State) {
				return nil, fmt.Errorf("%q step %q has state %q, want pass, fail or skip", shots[i].Name, st.Step, st.State)
			}
		}
		files := make([]string, 0, len(shots[i].Files))
		for _, f := range shots[i].Files {
			rel, ok := shotPathInside(f)
			if !ok {
				log.Printf("dag %s: reading %s: dropping %q's file %q, which is not inside %s", dagID, shotsManifestName, shots[i].Name, f, finalOutEnv)
				continue
			}
			files = append(files, rel)
		}
		shots[i].Files = files
	}
	return shots, nil
}

// shotPathInside cleans a manifest file path, and reports false for one that could name a file outside
// ARC_FINAL_OUT: absolute, on a drive, or climbing out with "..".
func shotPathInside(p string) (string, bool) {
	p = strings.ReplaceAll(p, `\`, "/")
	if p == "" || strings.HasPrefix(p, "/") || driveLetterRe.MatchString(p) || filepath.IsAbs(p) || filepath.VolumeName(p) != "" {
		return "", false
	}
	p = path.Clean(p)
	if p == "." || p == ".." || strings.HasPrefix(p, "../") {
		return "", false
	}
	return p, true
}

// listFinalShots is every PNG under outDir, sorted by path, as one shot each with no steps.
func listFinalShots(dagID, outDir string) []waveobj.FinalShot {
	var files []string
	err := filepath.WalkDir(outDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == outDir {
				return err
			}
			log.Printf("dag %s: listing %s: %v", dagID, p, err)
			return nil
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".png") {
			return nil
		}
		rel, err := filepath.Rel(outDir, p)
		if err != nil {
			return nil
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("dag %s: listing %s: %v", dagID, outDir, err)
	}
	slices.Sort(files)
	var shots []waveobj.FinalShot
	for _, f := range files {
		name := path.Base(f)
		shots = append(shots, waveobj.FinalShot{Name: name[:len(name)-len(path.Ext(name))], Files: []string{f}})
	}
	return shots
}

// SweepFinalShots removes the round dirs under finalShotsRoot last changed more than FinalShotsRetention before
// now, then the dag dirs that leaves empty. A dir it cannot remove is logged and left for the next sweep.
func SweepFinalShots(now time.Time) {
	root := finalShotsRoot()
	dags, err := os.ReadDir(root)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("sweeping final shots: %v", err)
		}
		return
	}
	cutoff := now.Add(-FinalShotsRetention)
	for _, d := range dags {
		if !d.IsDir() {
			continue
		}
		dagDir := filepath.Join(root, d.Name())
		rounds, err := os.ReadDir(dagDir)
		if err != nil {
			log.Printf("sweeping final shots: %v", err)
			continue
		}
		left := 0
		for _, r := range rounds {
			if sweepFinalRound(filepath.Join(dagDir, r.Name()), r, cutoff) {
				continue
			}
			left++
		}
		if left == 0 {
			if err := os.Remove(dagDir); err != nil {
				log.Printf("sweeping final shots: %v", err)
			}
		}
	}
}

// sweepFinalRound removes one round dir changed before cutoff, and reports whether it is gone.
func sweepFinalRound(dir string, e fs.DirEntry, cutoff time.Time) bool {
	if !e.IsDir() {
		return false
	}
	info, err := e.Info()
	if err != nil {
		log.Printf("sweeping final shots: %v", err)
		return false
	}
	if !info.ModTime().Before(cutoff) {
		return false
	}
	if err := os.RemoveAll(dir); err != nil {
		log.Printf("sweeping final shots: removing %s: %v", dir, err)
		return false
	}
	return true
}
