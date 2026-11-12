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
	answerExt        = ".json"
	talkExt          = ".talk.json"
	answersExt       = ".answers"
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

func checkUUID(kind, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return fmt.Errorf("invalid %s id %q", kind, id)
	}
	return nil
}

func checkAnswerID(id string) error { return checkUUID("answer", id) }

func boardPath(dir, id string) string { return filepath.Join(dir, id+boardExt) }
func talkPath(dir, id string) string  { return filepath.Join(dir, id+talkExt) }
func answersDir(dir, id string) string {
	return filepath.Join(dir, id+answersExt)
}

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
	}
	info.ActiveTs = info.CreatedTs
	if state != nil {
		info.State = state(id)
	}
	return info
}

// applyTalkFacts fills the list row's facts from the board's talk. A state the caller already set (the drawer is
// busy on it) wins; otherwise the last turn says: an asks turn with no choice yet asks, a failed one failed, and an
// answering or waiting one that nothing runs failed too.
func applyTalkFacts(info *wshrpc.BoardInfo, talk wshrpc.BoardTalk) {
	// the switcher says "the <project> code" itself when About is empty, so a project about stays empty here
	if talk.About.Kind != "" && talk.About.Kind != "project" {
		info.About = talk.About.Title
	}
	for _, t := range talk.Turns {
		if !t.Kept && (t.Question != "" || t.Briefing != nil) {
			info.Questions++
		}
		info.AnsweredTs = max(info.AnsweredTs, t.AnsweredTs)
		info.ActiveTs = max(info.ActiveTs, t.Ts, t.AnsweredTs)
	}
	if info.State != "" || len(talk.Turns) == 0 {
		return
	}
	switch last := talk.Turns[len(talk.Turns)-1]; {
	case last.State == "asks" && last.Choice == "":
		info.State = "asks"
	case last.State == "failed", last.State == "answering", last.State == "waiting":
		info.State = "failed"
	}
}

// List returns a project's boards, the most recently active first (a turn, an answer, else created), then by id.
// A missing project dir is no boards. A talk that will not read leaves its board listed without talk facts.
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
		info := infoFromFile(dir, channelId, id, data, modTs, state)
		if talk, err := ReadTalk(dir, id); err != nil {
			log.Printf("boardstore: listing board %s without its talk: %v\n", id, err)
		} else {
			applyTalkFacts(&info, talk)
		}
		boards = append(boards, info)
	}
	sort.SliceStable(boards, func(i, j int) bool {
		a, b := boards[i], boards[j]
		if a.ActiveTs != b.ActiveTs {
			return a.ActiveTs > b.ActiveTs
		}
		return a.ID < b.ID
	})
	return boards, nil
}

// checkElements refuses anything but a JSON array, so a copied drawing cannot corrupt the board file.
func checkElements(elements string) error {
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(elements), &arr); err != nil || arr == nil {
		return errors.New("elements must be a JSON array")
	}
	return nil
}

// Create writes a new board named name, with elements (a JSON array; empty means none) as its drawing. The arc
// record is the file's first key.
func Create(dir, channelId, name, elements string, now int64) (wshrpc.BoardInfo, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return wshrpc.BoardInfo{}, errors.New(errNameRequired)
	}
	if elements == "" {
		elements = "[]"
	} else if err := checkElements(elements); err != nil {
		return wshrpc.BoardInfo{}, err
	}
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return wshrpc.BoardInfo{}, err
	}
	arc, err := json.Marshal(wshrpc.BoardArcRecord{Name: name, CreatedTs: now})
	if err != nil {
		return wshrpc.BoardInfo{}, err
	}
	body := `{"arc":` + string(arc) + `,"type":"excalidraw","version":2,"source":"arc","elements":` + elements + `,"appState":{},"files":{}}`

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

func readTalkFile(dir, boardId string) (wshrpc.BoardTalk, error) {
	talk := wshrpc.BoardTalk{BoardId: boardId}
	data, err := os.ReadFile(talkPath(dir, boardId))
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return wshrpc.BoardTalk{}, err
	default:
		if err := json.Unmarshal(data, &talk); err != nil {
			return wshrpc.BoardTalk{}, fmt.Errorf("the talk of board %s is damaged: %w", boardId, err)
		}
	}
	if talk.Turns == nil {
		talk.Turns = []wshrpc.BoardTurn{}
	}
	return talk, nil
}

// ReadTalk returns a board's talk; a board with no talk file has an empty one.
func ReadTalk(dir, boardId string) (wshrpc.BoardTalk, error) {
	if err := checkID(boardId); err != nil {
		return wshrpc.BoardTalk{}, err
	}
	l := dirLock(dir)
	l.Lock()
	defer l.Unlock()
	return readTalkFile(dir, boardId)
}

// UpdateTalk reads the board's talk, lets fn change it and writes it back, all under the dir lock, so concurrent
// updates serialize. An error from fn writes nothing. Only wavesrv writes the talk: the frontend owns the board file.
func UpdateTalk(dir, boardId string, fn func(*wshrpc.BoardTalk) error) (wshrpc.BoardTalk, error) {
	if err := checkID(boardId); err != nil {
		return wshrpc.BoardTalk{}, err
	}
	l := dirLock(dir)
	l.Lock()
	defer l.Unlock()
	talk, err := readTalkFile(dir, boardId)
	if err != nil {
		return wshrpc.BoardTalk{}, err
	}
	if err := fn(&talk); err != nil {
		return wshrpc.BoardTalk{}, err
	}
	if talk.Turns == nil {
		talk.Turns = []wshrpc.BoardTurn{}
	}
	data, err := json.Marshal(talk)
	if err != nil {
		return wshrpc.BoardTalk{}, err
	}
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return wshrpc.BoardTalk{}, err
	}
	if err := fileutil.AtomicWriteFile(talkPath(dir, boardId), data, fileMode); err != nil {
		return wshrpc.BoardTalk{}, err
	}
	return talk, nil
}

// PutAnswer files a drawer answer in the board's inbox, where it waits until the frontend applies and acks it.
func PutAnswer(dir string, a wshrpc.BoardAnswer) error {
	if err := checkID(a.BoardId); err != nil {
		return err
	}
	if err := checkAnswerID(a.ID); err != nil {
		return err
	}
	data, err := json.Marshal(a)
	if err != nil {
		return err
	}
	inbox := answersDir(dir, a.BoardId)
	if err := os.MkdirAll(inbox, dirMode); err != nil {
		return err
	}
	return fileutil.AtomicWriteFile(filepath.Join(inbox, a.ID+answerExt), data, fileMode)
}

// Answers returns a board's waiting answers, oldest first. An empty boardId returns every board's in dir.
func Answers(dir, boardId string) ([]wshrpc.BoardAnswer, error) {
	var ids []string
	if boardId != "" {
		if err := checkID(boardId); err != nil {
			return nil, err
		}
		ids = []string{boardId}
	} else {
		entries, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			return []wshrpc.BoardAnswer{}, nil
		}
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if id, ok := strings.CutSuffix(e.Name(), answersExt); ok && e.IsDir() && ValidID(id) {
				ids = append(ids, id)
			}
		}
	}
	answers := []wshrpc.BoardAnswer{}
	for _, id := range ids {
		files, err := os.ReadDir(answersDir(dir, id))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), answerExt) {
				continue
			}
			path := filepath.Join(answersDir(dir, id), f.Name())
			data, err := os.ReadFile(path)
			var a wshrpc.BoardAnswer
			if err == nil {
				err = json.Unmarshal(data, &a)
			}
			if err != nil {
				// one unreadable answer must not hide the rest of the inbox
				log.Printf("boardstore: skipping unreadable answer %s: %v\n", path, err)
				continue
			}
			answers = append(answers, a)
		}
	}
	sort.SliceStable(answers, func(i, j int) bool {
		if answers[i].Ts != answers[j].Ts {
			return answers[i].Ts < answers[j].Ts
		}
		return answers[i].ID < answers[j].ID
	})
	return answers, nil
}

// AckAnswer removes an applied answer from the inbox. An answer that is already gone is not an error.
func AckAnswer(dir, boardId, answerId string) error {
	if err := checkID(boardId); err != nil {
		return err
	}
	if err := checkAnswerID(answerId); err != nil {
		return err
	}
	err := os.Remove(filepath.Join(answersDir(dir, boardId), answerId+answerExt))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
