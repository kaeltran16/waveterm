// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	boardExt         = ".excalidraw"
	inboxExt         = ".inbox"
	drawExt          = ".json"
	idLen            = 8
	namePrefixBytes  = 4096
	fileMode         = 0o644
	dirMode          = 0o755
	errNameRequired  = "Type a name first"
	unsafeNameChars  = `<>:"/\|?*`
	unsafeNameFiller = "_"
)

var (
	idRe = regexp.MustCompile(`^[0-9a-f]{8}$`)
	// the arc record is the file's first key, so a file damaged further down still names itself
	nameRe = regexp.MustCompile(`"name"\s*:\s*("(?:[^"\\]|\\.)*")`)

	dirLocksMu sync.Mutex
	dirLocks   = map[string]*sync.Mutex{}
)

// arcFile is the part of a board file this package reads.
type arcFile struct {
	Arc *wshrpc.BoardArcRecord `json:"arc"`
}

// Root is the folder every project's boards live under.
func Root() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "boards")
}

// ProjectDir is a project's board folder: the project name with characters a path cannot hold, and trailing
// dots and spaces, replaced by "_".
func ProjectDir(project string) string {
	name := []rune(project)
	for i, r := range name {
		if strings.ContainsRune(unsafeNameChars, r) || r < ' ' {
			name[i] = '_'
		}
	}
	for i := len(name) - 1; i >= 0 && (name[i] == '.' || name[i] == ' '); i-- {
		name[i] = '_'
	}
	if len(name) == 0 {
		name = []rune(unsafeNameFiller)
	}
	return filepath.Join(Root(), string(name))
}

func ValidID(id string) bool {
	return idRe.MatchString(id)
}

func checkID(id string) error {
	if !ValidID(id) {
		return fmt.Errorf("invalid board id %q", id)
	}
	return nil
}

func checkDrawID(id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return fmt.Errorf("invalid draw id %q", id)
	}
	return nil
}

func boardPath(dir, id string) string { return filepath.Join(dir, id+boardExt) }
func inboxDir(dir, id string) string  { return filepath.Join(dir, id+inboxExt) }

func dirLock(dir string) *sync.Mutex {
	dirLocksMu.Lock()
	defer dirLocksMu.Unlock()
	l, ok := dirLocks[dir]
	if !ok {
		l = &sync.Mutex{}
		dirLocks[dir] = l
	}
	return l
}

func revOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func lineAt(data []byte, offset int64) int {
	offset = max(0, min(offset, int64(len(data))))
	return 1 + bytes.Count(data[:offset], []byte{'\n'})
}

// parseArc returns the board's record, or the text of why its file cannot be used.
func parseArc(data []byte) (wshrpc.BoardArcRecord, string) {
	var f arcFile
	if err := json.Unmarshal(data, &f); err != nil {
		var offset int64
		var syn *json.SyntaxError
		var typ *json.UnmarshalTypeError
		switch {
		case errors.As(err, &syn):
			offset = syn.Offset
		case errors.As(err, &typ):
			offset = typ.Offset
		}
		return wshrpc.BoardArcRecord{}, fmt.Sprintf("its file is not valid Excalidraw JSON (%s, at line %d)", err.Error(), lineAt(data, offset))
	}
	if f.Arc == nil {
		return wshrpc.BoardArcRecord{}, "its file is not valid Excalidraw JSON (no arc record, at line 1)"
	}
	return *f.Arc, ""
}

func fallbackName(data []byte, id string) string {
	prefix := data[:min(len(data), namePrefixBytes)]
	if m := nameRe.FindSubmatch(prefix); m != nil {
		var name string
		if json.Unmarshal(m[1], &name) == nil && strings.TrimSpace(name) != "" {
			return name
		}
	}
	return id
}

func infoFromFile(dir, channelId, id string, data []byte, modTs int64, state func(string) string) wshrpc.BoardInfo {
	abs, err := filepath.Abs(boardPath(dir, id))
	if err != nil {
		abs = boardPath(dir, id)
	}
	info := wshrpc.BoardInfo{ID: id, ChannelId: channelId, Path: abs}
	rec, loadErr := parseArc(data)
	if loadErr != "" {
		info.Name = fallbackName(data, id)
		info.CreatedTs = modTs
		info.LoadError = loadErr
	} else {
		info.Name = rec.Name
		info.CreatedTs = rec.CreatedTs
		info.Groups = len(rec.Sources)
		for _, s := range rec.Sources {
			info.LastDrawnTs = max(info.LastDrawnTs, s.DrawnTs)
			if s.DrawnTs > rec.SeenTs {
				info.NewCount++
			}
		}
	}
	if state != nil {
		info.State = state(id)
	}
	return info
}

// List returns a project's boards: drawn ones most recently drawn first, then never-drawn ones by created time.
// A missing project dir is no boards.
func List(dir, channelId string, state func(boardId string) string) ([]wshrpc.BoardInfo, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []wshrpc.BoardInfo{}, nil
	}
	if err != nil {
		return nil, err
	}
	boards := []wshrpc.BoardInfo{}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), boardExt)
		if !ok || e.IsDir() || !ValidID(id) {
			continue
		}
		data, err := os.ReadFile(boardPath(dir, id))
		if err != nil {
			return nil, err
		}
		var modTs int64
		if st, err := e.Info(); err == nil {
			modTs = st.ModTime().UnixMilli()
		}
		boards = append(boards, infoFromFile(dir, channelId, id, data, modTs, state))
	}
	sort.SliceStable(boards, func(i, j int) bool {
		a, b := boards[i], boards[j]
		if (a.LastDrawnTs > 0) != (b.LastDrawnTs > 0) {
			return a.LastDrawnTs > 0
		}
		if a.LastDrawnTs != b.LastDrawnTs {
			return a.LastDrawnTs > b.LastDrawnTs
		}
		if a.CreatedTs != b.CreatedTs {
			return a.CreatedTs > b.CreatedTs
		}
		return a.ID < b.ID
	})
	return boards, nil
}

// Create writes a new empty board named name. The arc record is the file's first key.
func Create(dir, channelId, name string, now int64) (wshrpc.BoardInfo, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return wshrpc.BoardInfo{}, errors.New(errNameRequired)
	}
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return wshrpc.BoardInfo{}, err
	}
	arc, err := json.Marshal(wshrpc.BoardArcRecord{Name: name, CreatedTs: now})
	if err != nil {
		return wshrpc.BoardInfo{}, err
	}
	body := `{"arc":` + string(arc) + `,"type":"excalidraw","version":2,"source":"arc","elements":[],"appState":{},"files":{}}`

	l := dirLock(dir)
	l.Lock()
	defer l.Unlock()
	var id string
	for {
		id = uuid.NewString()[:idLen]
		if _, err := os.Stat(boardPath(dir, id)); errors.Is(err, os.ErrNotExist) {
			break
		}
	}
	if err := fileutil.AtomicWriteFile(boardPath(dir, id), []byte(body), fileMode); err != nil {
		return wshrpc.BoardInfo{}, err
	}
	return infoFromFile(dir, channelId, id, []byte(body), now, nil), nil
}

// Read returns a board. A file that will not parse comes back as its error text, with Info (name, path and
// LoadError) filled so a caller can still show the board.
func Read(dir, channelId, id string) (wshrpc.BoardReadRtnData, error) {
	if err := checkID(id); err != nil {
		return wshrpc.BoardReadRtnData{}, err
	}
	data, err := os.ReadFile(boardPath(dir, id))
	if errors.Is(err, os.ErrNotExist) {
		return wshrpc.BoardReadRtnData{}, fmt.Errorf("board %s not found", id)
	}
	if err != nil {
		return wshrpc.BoardReadRtnData{}, err
	}
	var modTs int64
	if st, err := os.Stat(boardPath(dir, id)); err == nil {
		modTs = st.ModTime().UnixMilli()
	}
	info := infoFromFile(dir, channelId, id, data, modTs, nil)
	if info.LoadError != "" {
		return wshrpc.BoardReadRtnData{Info: info}, errors.New(info.LoadError)
	}
	rec, _ := parseArc(data)
	return wshrpc.BoardReadRtnData{Info: info, Data: string(data), Rev: revOf(data), Arc: rec}, nil
}

// Save replaces a board's file with data when baseRev is the file's current rev; otherwise nothing is written
// and Conflict is set. A file that will not parse is never overwritten.
func Save(dir, id, data, baseRev string) (wshrpc.BoardSaveRtnData, error) {
	if err := checkID(id); err != nil {
		return wshrpc.BoardSaveRtnData{}, err
	}
	rec, loadErr := parseArc([]byte(data))
	if loadErr != "" || strings.TrimSpace(rec.Name) == "" {
		return wshrpc.BoardSaveRtnData{}, errors.New("refusing to save: data has no arc record with a name")
	}

	l := dirLock(dir)
	l.Lock()
	defer l.Unlock()
	path := boardPath(dir, id)
	current, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return wshrpc.BoardSaveRtnData{}, fmt.Errorf("board %s not found", id)
	}
	if err != nil {
		return wshrpc.BoardSaveRtnData{}, err
	}
	if _, loadErr := parseArc(current); loadErr != "" {
		return wshrpc.BoardSaveRtnData{}, fmt.Errorf("refusing to overwrite board %s: %s", id, loadErr)
	}
	if revOf(current) != baseRev {
		return wshrpc.BoardSaveRtnData{Conflict: true}, nil
	}
	if err := fileutil.AtomicWriteFile(path, []byte(data), fileMode); err != nil {
		return wshrpc.BoardSaveRtnData{}, err
	}
	return wshrpc.BoardSaveRtnData{Rev: revOf([]byte(data))}, nil
}

// PutDraw files a scribe result in the board's inbox, where it waits until the frontend applies and acks it.
func PutDraw(dir string, d wshrpc.BoardDraw) error {
	if err := checkID(d.BoardId); err != nil {
		return err
	}
	if err := checkDrawID(d.ID); err != nil {
		return err
	}
	data, err := json.Marshal(d)
	if err != nil {
		return err
	}
	inbox := inboxDir(dir, d.BoardId)
	if err := os.MkdirAll(inbox, dirMode); err != nil {
		return err
	}
	return fileutil.AtomicWriteFile(filepath.Join(inbox, d.ID+drawExt), data, fileMode)
}

// Draws returns a board's waiting draws, oldest first. An empty boardId returns every board's in dir.
func Draws(dir, boardId string) ([]wshrpc.BoardDraw, error) {
	var ids []string
	if boardId != "" {
		if err := checkID(boardId); err != nil {
			return nil, err
		}
		ids = []string{boardId}
	} else {
		entries, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			return []wshrpc.BoardDraw{}, nil
		}
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if id, ok := strings.CutSuffix(e.Name(), inboxExt); ok && e.IsDir() && ValidID(id) {
				ids = append(ids, id)
			}
		}
	}
	draws := []wshrpc.BoardDraw{}
	for _, id := range ids {
		files, err := os.ReadDir(inboxDir(dir, id))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), drawExt) {
				continue
			}
			path := filepath.Join(inboxDir(dir, id), f.Name())
			data, err := os.ReadFile(path)
			var d wshrpc.BoardDraw
			if err == nil {
				err = json.Unmarshal(data, &d)
			}
			if err != nil {
				// one unreadable draw must not hide the rest of the inbox
				log.Printf("boardstore: skipping unreadable draw %s: %v\n", path, err)
				continue
			}
			draws = append(draws, d)
		}
	}
	sort.SliceStable(draws, func(i, j int) bool {
		if draws[i].Ts != draws[j].Ts {
			return draws[i].Ts < draws[j].Ts
		}
		return draws[i].ID < draws[j].ID
	})
	return draws, nil
}

// AckDraw removes an applied draw from the inbox. A draw that is already gone is not an error.
func AckDraw(dir, boardId, drawId string) error {
	if err := checkID(boardId); err != nil {
		return err
	}
	if err := checkDrawID(drawId); err != nil {
		return err
	}
	err := os.Remove(filepath.Join(inboxDir(dir, boardId), drawId+drawExt))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Previous returns the source's last skeleton and cursor: the newest unacked inbox draw for key, else the
// board file's entry for it, else nothing.
func Previous(dir, boardId, key string) (skeleton string, cursorTs int64, err error) {
	// Draws reads every board's inbox for an empty id, which would hand back another board's skeleton
	if err := checkID(boardId); err != nil {
		return "", 0, err
	}
	draws, err := Draws(dir, boardId)
	if err != nil {
		return "", 0, err
	}
	for i := len(draws) - 1; i >= 0; i-- {
		if draws[i].SourceKey == key {
			return draws[i].Skeleton, draws[i].CursorTs, nil
		}
	}
	data, err := os.ReadFile(boardPath(dir, boardId))
	if err != nil {
		return "", 0, err
	}
	rec, loadErr := parseArc(data)
	if loadErr != "" {
		return "", 0, errors.New(loadErr)
	}
	for _, s := range rec.Sources {
		if s.Key == key {
			return s.Skeleton, s.CursorTs, nil
		}
	}
	return "", 0, nil
}
