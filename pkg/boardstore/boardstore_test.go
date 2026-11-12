// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardstore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const testChannel = "chan-1"

func mustCreate(t *testing.T, dir, name string, now int64) wshrpc.BoardInfo {
	t.Helper()
	info, err := Create(dir, testChannel, name, "", now)
	if err != nil {
		t.Fatalf("create %q: %v", name, err)
	}
	return info
}

func TestBoardStoreCreateListRead(t *testing.T) {
	dir := t.TempDir()
	a := mustCreate(t, dir, "  Auth flow ", 1000)
	b := mustCreate(t, dir, "Deploy", 2000)
	if a.Name != "Auth flow" || !ValidID(a.ID) || a.ChannelId != testChannel || a.CreatedTs != 1000 {
		t.Fatalf("create info: %+v", a)
	}

	raw, err := os.ReadFile(boardPath(dir, a.ID))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), `{"arc":`) {
		t.Fatalf("arc must be the first key, got %.40s", raw)
	}
	var file map[string]any
	if err := json.Unmarshal(raw, &file); err != nil || file["type"] != "excalidraw" || file["source"] != "arc" {
		t.Fatalf("not an excalidraw file: %v %v", err, file)
	}

	// no talk: newest created first
	list, err := List(dir, testChannel, nil)
	if err != nil || len(list) != 2 || list[0].ID != b.ID || list[1].ID != a.ID {
		t.Fatalf("created order: %v %+v", err, list)
	}

	state := func(id string) string {
		if id == a.ID {
			return "drawing"
		}
		return ""
	}
	list, err = List(dir, testChannel, state)
	if err != nil || len(list) != 2 {
		t.Fatalf("list: %v %+v", err, list)
	}
	got, other := list[1], list[0]
	if got.ID != a.ID {
		got, other = other, got
	}
	if got.State != "drawing" || other.State != "" {
		t.Fatalf("list row: %+v", got)
	}
	if !filepath.IsAbs(got.Path) || filepath.Base(got.Path) != a.ID+".excalidraw" {
		t.Fatalf("path: %q", got.Path)
	}

	read, err := Read(dir, testChannel, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if read.Arc.Name != "Auth flow" || read.Arc.CreatedTs != 1000 || read.Rev == "" || read.Info.ID != a.ID {
		t.Fatalf("read: %+v", read)
	}
	if _, err := Read(dir, testChannel, "00000000"); err == nil {
		t.Fatal("reading a missing board should fail")
	}
}

func TestBoardStoreMissingDirListsEmpty(t *testing.T) {
	list, err := List(filepath.Join(t.TempDir(), "nope"), testChannel, nil)
	if err != nil || len(list) != 0 {
		t.Fatalf("got %v %v", list, err)
	}
}

func TestBoardStoreCreateRefusesEmptyName(t *testing.T) {
	dir := t.TempDir()
	_, err := Create(dir, testChannel, "   ", "", 1)
	if err == nil || err.Error() != "Type a name first" {
		t.Fatalf("err: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("nothing should be written, got %d entries", len(entries))
	}
}

func TestBoardStoreSaveConflict(t *testing.T) {
	dir := t.TempDir()
	info := mustCreate(t, dir, "Flow", 1)
	first, err := Read(dir, testChannel, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved := `{"arc":{"name":"Flow","createdts":1},"type":"excalidraw","elements":[{"id":"a"}]}`
	res, err := Save(dir, info.ID, saved, first.Rev)
	if err != nil || res.Conflict || res.Rev == "" || res.Rev == first.Rev {
		t.Fatalf("first save: %v %+v", err, res)
	}
	after, _ := os.ReadFile(boardPath(dir, info.ID))
	if string(after) != saved {
		t.Fatal("saved bytes differ")
	}
	if reread, _ := Read(dir, testChannel, info.ID); reread.Rev != res.Rev {
		t.Fatalf("rev %q != saved rev %q", reread.Rev, res.Rev)
	}

	// a writer still holding the old rev loses and the file stays as the winner wrote it
	stale, err := Save(dir, info.ID, `{"arc":{"name":"Other"}}`, first.Rev)
	if err != nil || !stale.Conflict || stale.Rev != "" {
		t.Fatalf("stale save: %v %+v", err, stale)
	}
	if now, _ := os.ReadFile(boardPath(dir, info.ID)); string(now) != saved {
		t.Fatal("a conflicting save changed the file")
	}
}

func TestBoardStoreSaveRefusesBadData(t *testing.T) {
	dir := t.TempDir()
	info := mustCreate(t, dir, "Flow", 1)
	read, _ := Read(dir, testChannel, info.ID)
	for name, data := range map[string]string{
		"not json":   `{"arc":`,
		"no arc":     `{"elements":[]}`,
		"empty name": `{"arc":{"name":"  "}}`,
		"arc string": `{"arc":"x"}`,
	} {
		if _, err := Save(dir, info.ID, data, read.Rev); err == nil {
			t.Errorf("%s: save should refuse", name)
		}
	}
	if _, err := Save(dir, "00000000", `{"arc":{"name":"x"}}`, ""); err == nil {
		t.Error("save to a missing board should refuse")
	}
}

func TestBoardStoreDamagedFile(t *testing.T) {
	dir := t.TempDir()
	info := mustCreate(t, dir, "Auth flow", 1)
	path := boardPath(dir, info.ID)
	raw, _ := os.ReadFile(path)
	cut := raw[:len(raw)/2]
	if err := os.WriteFile(path, cut, 0o644); err != nil {
		t.Fatal(err)
	}

	list, err := List(dir, testChannel, nil)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %+v", err, list)
	}
	row := list[0]
	if !strings.HasPrefix(row.LoadError, "its file is not valid Excalidraw JSON (") || !strings.Contains(row.LoadError, ", at line 1)") {
		t.Fatalf("load error: %q", row.LoadError)
	}
	if row.Name != "Auth flow" {
		t.Fatalf("name should come from the arc prefix, got %q", row.Name)
	}

	read, err := Read(dir, testChannel, info.ID)
	if err == nil || err.Error() != row.LoadError || read.Info.LoadError != row.LoadError {
		t.Fatalf("read: %v %+v", err, read.Info)
	}

	if _, err := Save(dir, info.ID, `{"arc":{"name":"x"}}`, ""); err == nil || !strings.Contains(err.Error(), row.LoadError) {
		t.Fatalf("save should refuse naming the load error, got %v", err)
	}
	if now, _ := os.ReadFile(path); string(now) != string(cut) {
		t.Fatal("a refused save changed the damaged file")
	}

	// no arc prefix at all: the id stands in for the name
	if err := os.WriteFile(path, []byte(`{`), 0o644); err != nil {
		t.Fatal(err)
	}
	list, _ = List(dir, testChannel, nil)
	if list[0].Name != info.ID || list[0].LoadError == "" {
		t.Fatalf("fallback name: %+v", list[0])
	}
}

func TestBoardStoreRejectsBadIDs(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "x.excalidraw"), []byte(`{"arc":{"name":"x"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	answer := wshrpc.BoardAnswer{ID: uuid.NewString(), BoardId: "", Ts: 1}
	for _, id := range []string{"../x", "ABCDEF12", "7c1e0b4", "7c1e0b4ff", "", `..\x`} {
		if ValidID(id) {
			t.Errorf("ValidID(%q) = true", id)
		}
		if _, err := Read(dir, testChannel, id); err == nil {
			t.Errorf("Read(%q) should refuse", id)
		}
		if _, err := Save(dir, id, `{"arc":{"name":"x"}}`, ""); err == nil {
			t.Errorf("Save(%q) should refuse", id)
		}
		answer.BoardId = id
		if err := PutAnswer(dir, answer); err == nil {
			t.Errorf("PutAnswer(%q) should refuse", id)
		}
		if id != "" { // an empty board id means every board
			if _, err := Answers(dir, id); err == nil {
				t.Errorf("Answers(%q) should refuse", id)
			}
		}
		if err := AckAnswer(dir, id, uuid.NewString()); err == nil {
			t.Errorf("AckAnswer(%q) should refuse", id)
		}
	}
	if err := AckAnswer(dir, "7c1e0b4f", "../../x"); err == nil {
		t.Error("AckAnswer should refuse an answer id that is not a uuid")
	}
	if err := PutAnswer(dir, wshrpc.BoardAnswer{ID: "../x", BoardId: "7c1e0b4f"}); err == nil {
		t.Error("PutAnswer should refuse an answer id that is not a uuid")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("a refused call wrote into the dir: %v", entries)
	}
}

func TestBoardStoreProjectDirSanitizes(t *testing.T) {
	cases := map[string]string{
		`a:b?`:       "a_b_",
		`x/y\z`:      "x_y_z",
		`a<b>c"d|e*`: "a_b_c_d_e_",
		"name. .":    "name___",
		"":           "_",
		"..":         "__",
		"wave term":  "wave term",
	}
	for in, want := range cases {
		got := ProjectDir(in)
		if filepath.Base(got) != want || filepath.Dir(got) != Root() {
			t.Errorf("ProjectDir(%q) = %q, want base %q under %q", in, got, want, Root())
		}
	}
	if filepath.Base(Root()) != "boards" {
		t.Errorf("Root() = %q", Root())
	}
}

const unknownBoard = "7c1e0b4f"

func TestTalkMissingIsEmpty(t *testing.T) {
	dir := t.TempDir()
	talk, err := ReadTalk(dir, unknownBoard)
	if err != nil || talk.Turns == nil || len(talk.Turns) != 0 || talk.BoardId != unknownBoard {
		t.Fatalf("missing talk: %v %+v", err, talk)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("reading wrote %d entries", len(entries))
	}
}

func TestUpdateTalkRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := wshrpc.BoardTalk{
		ChannelId: testChannel,
		BoardId:   unknownBoard,
		About:     wshrpc.BoardSource{Kind: "agent", Ref: "t1", Title: "wavesrv"},
		SessionId: uuid.NewString(),
		Handoff:   &wshrpc.BoardHandoff{FromBoardId: "aaaa0001", FromName: "Auth", Summary: "s", Shapes: 3},
		Turns: []wshrpc.BoardTurn{
			{ID: "t1", Ts: 5, Question: "q", On: "wavesrv", SelectedIds: []string{"a"}, State: "answered", ShapeIds: []string{"a", "b"}, Added: 2},
			{ID: "t2", Ts: 6, Briefing: &wshrpc.BoardBriefing{From: "claude", Text: "x", Ask: "y"}, State: "asks"},
		},
	}
	got, err := UpdateTalk(dir, unknownBoard, func(tk *wshrpc.BoardTalk) error {
		*tk = want
		return nil
	})
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("update returned: %v %+v", err, got)
	}
	read, err := ReadTalk(dir, unknownBoard)
	if err != nil || !reflect.DeepEqual(read, want) {
		t.Fatalf("read back: %v %+v", err, read)
	}
	if _, err := os.Stat(filepath.Join(dir, unknownBoard+".talk.json")); err != nil {
		t.Fatalf("talk file: %v", err)
	}
}

func TestUpdateTalkSerializesConcurrentUpdates(t *testing.T) {
	dir := t.TempDir()
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := UpdateTalk(dir, unknownBoard, func(tk *wshrpc.BoardTalk) error {
				tk.Turns = append(tk.Turns, wshrpc.BoardTurn{ID: uuid.NewString(), State: "answered"})
				return nil
			})
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if talk, err := ReadTalk(dir, unknownBoard); err != nil || len(talk.Turns) != n {
		t.Fatalf("turns after %d updates: %v %d", n, err, len(talk.Turns))
	}
}

func TestUpdateTalkErrorWritesNothing(t *testing.T) {
	dir := t.TempDir()
	boom := errors.New("boom")
	if _, err := UpdateTalk(dir, unknownBoard, func(tk *wshrpc.BoardTalk) error {
		tk.Turns = append(tk.Turns, wshrpc.BoardTurn{ID: "x"})
		return boom
	}); !errors.Is(err, boom) {
		t.Fatalf("err: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("a failed update created %d entries", len(entries))
	}

	if _, err := UpdateTalk(dir, unknownBoard, func(tk *wshrpc.BoardTalk) error {
		tk.Turns = append(tk.Turns, wshrpc.BoardTurn{ID: "one", State: "answered"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, unknownBoard+".talk.json")
	before, _ := os.ReadFile(path)
	if _, err := UpdateTalk(dir, unknownBoard, func(tk *wshrpc.BoardTalk) error {
		tk.Turns = append(tk.Turns, wshrpc.BoardTurn{ID: "two"})
		return boom
	}); !errors.Is(err, boom) {
		t.Fatalf("err: %v", err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatal("a failed update changed the talk file")
	}
}

func TestTalkRefusesBadId(t *testing.T) {
	dir := t.TempDir()
	for _, id := range []string{"../x", "ABCDEF12", "7c1e0b4", "", `..\x`} {
		if _, err := ReadTalk(dir, id); err == nil {
			t.Errorf("ReadTalk(%q) should refuse", id)
		}
		called := false
		if _, err := UpdateTalk(dir, id, func(*wshrpc.BoardTalk) error { called = true; return nil }); err == nil || called {
			t.Errorf("UpdateTalk(%q) should refuse before calling fn", id)
		}
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("a refused call wrote into the dir: %v", entries)
	}
}

func TestCreateWritesElements(t *testing.T) {
	dir := t.TempDir()
	info, err := Create(dir, testChannel, "Copy", `[{"id":"a","type":"rectangle"}]`, 7)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(boardPath(dir, info.ID))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Elements []map[string]any `json:"elements"`
	}
	if err := json.Unmarshal(raw, &file); err != nil || len(file.Elements) != 1 || file.Elements[0]["id"] != "a" {
		t.Fatalf("elements: %v %+v", err, file)
	}
	if !strings.HasPrefix(string(raw), `{"arc":`) {
		t.Fatalf("arc must stay the first key, got %.40s", raw)
	}
	if read, err := Read(dir, testChannel, info.ID); err != nil || read.Arc.Name != "Copy" {
		t.Fatalf("read: %v %+v", err, read.Arc)
	}

	other := t.TempDir()
	for _, bad := range []string{"{}", "nope", "null", `[1,`, `"x"`} {
		if _, err := Create(other, testChannel, "Bad", bad, 1); err == nil {
			t.Errorf("elements %q should be refused", bad)
		}
	}
	if entries, _ := os.ReadDir(other); len(entries) != 0 {
		t.Fatalf("a refused create wrote %d entries", len(entries))
	}
}

func newAnswer(board string, ts int64) wshrpc.BoardAnswer {
	return wshrpc.BoardAnswer{ID: uuid.NewString(), ChannelId: testChannel, BoardId: board, TurnId: "t", Add: `[{"id":"n"}]`, Remove: []string{"r"}, Ts: ts}
}

func TestAnswersPutListAck(t *testing.T) {
	dir := t.TempDir()
	a := mustCreate(t, dir, "A", 1)
	b := mustCreate(t, dir, "B", 2)
	older, newer, other := newAnswer(a.ID, 100), newAnswer(a.ID, 200), newAnswer(b.ID, 150)
	for _, ans := range []wshrpc.BoardAnswer{newer, older, other} { // written out of order
		if err := PutAnswer(dir, ans); err != nil {
			t.Fatal(err)
		}
	}
	junk := filepath.Join(dir, a.ID+".answers", uuid.NewString()+".json")
	if err := os.WriteFile(junk, []byte("{nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := Answers(dir, a.ID)
	if err != nil || len(got) != 2 || got[0].ID != older.ID || got[1].ID != newer.ID {
		t.Fatalf("oldest first, unreadable skipped: %v %+v", err, got)
	}
	if !reflect.DeepEqual(got[1], newer) {
		t.Fatalf("round trip: %+v", got[1])
	}
	all, err := Answers(dir, "")
	if err != nil || len(all) != 3 || all[0].ID != older.ID || all[1].ID != other.ID || all[2].ID != newer.ID {
		t.Fatalf("every board, oldest first: %v %+v", err, all)
	}

	if err := AckAnswer(dir, a.ID, newer.ID); err != nil {
		t.Fatal(err)
	}
	if err := AckAnswer(dir, a.ID, newer.ID); err != nil {
		t.Fatalf("acking twice: %v", err)
	}
	if err := AckAnswer(dir, unknownBoard, uuid.NewString()); err != nil {
		t.Fatalf("acking on a board with no inbox: %v", err)
	}
	if left, _ := Answers(dir, a.ID); len(left) != 1 || left[0].ID != older.ID {
		t.Fatalf("left: %+v", left)
	}
	if none, err := Answers(dir, unknownBoard); err != nil || len(none) != 0 {
		t.Fatalf("no inbox: %v %v", none, err)
	}
	if none, err := Answers(filepath.Join(dir, "nope"), ""); err != nil || len(none) != 0 {
		t.Fatalf("missing dir: %v %v", none, err)
	}

	bad := newAnswer(a.ID, 1)
	bad.ID = "../x"
	if err := PutAnswer(dir, bad); err == nil {
		t.Error("PutAnswer should refuse an answer id that is not a uuid")
	}
	if err := AckAnswer(dir, a.ID, "../../x"); err == nil {
		t.Error("AckAnswer should refuse an answer id that is not a uuid")
	}
	for _, id := range []string{"../x", "ABCDEF12", ""} {
		if err := PutAnswer(dir, newAnswer(id, 1)); err == nil {
			t.Errorf("PutAnswer(%q) should refuse", id)
		}
		if err := AckAnswer(dir, id, uuid.NewString()); err == nil {
			t.Errorf("AckAnswer(%q) should refuse", id)
		}
		if id != "" { // an empty board id means every board
			if _, err := Answers(dir, id); err == nil {
				t.Errorf("Answers(%q) should refuse", id)
			}
		}
	}
}

func putTalk(t *testing.T, dir, id, about string, turns ...wshrpc.BoardTurn) {
	t.Helper()
	if _, err := UpdateTalk(dir, id, func(tk *wshrpc.BoardTalk) error {
		tk.About = wshrpc.BoardSource{Kind: "agent", Title: about}
		tk.Turns = turns
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestListTalkFacts(t *testing.T) {
	dir := t.TempDir()
	asks := mustCreate(t, dir, "asks", 1)
	kept := mustCreate(t, dir, "kept", 2)
	failed := mustCreate(t, dir, "failed", 3)
	stale := mustCreate(t, dir, "stale", 4)
	chosen := mustCreate(t, dir, "chosen", 5)
	bare1 := mustCreate(t, dir, "bare1", 6)
	bare2 := mustCreate(t, dir, "bare2", 6)

	putTalk(t, dir, asks.ID, "wavesrv",
		wshrpc.BoardTurn{ID: "t1", Ts: 100, Question: "q", State: "answered", AnsweredTs: 150},
		wshrpc.BoardTurn{ID: "t2", Ts: 200, Briefing: &wshrpc.BoardBriefing{From: "claude", Text: "x", Ask: "y"}, State: "asks"})
	putTalk(t, dir, kept.ID, "",
		wshrpc.BoardTurn{ID: "t1", Ts: 400, Question: "q", State: "answered", AnsweredTs: 450},
		wshrpc.BoardTurn{ID: "t2", Ts: 500, Question: "y", Kept: true, State: "answered", AnsweredTs: 550})
	putTalk(t, dir, failed.ID, "", wshrpc.BoardTurn{ID: "t1", Ts: 300, Question: "q", State: "failed", Reason: "r"})
	putTalk(t, dir, stale.ID, "", wshrpc.BoardTurn{ID: "t1", Ts: 50, Question: "q", State: "answering"})
	putTalk(t, dir, chosen.ID, "", wshrpc.BoardTurn{ID: "t1", Ts: 10, Question: "q", State: "asks", Choice: "new"})

	state := func(id string) string {
		if id == stale.ID {
			return "answering"
		}
		return ""
	}
	list, err := List(dir, testChannel, state)
	if err != nil || len(list) != 7 {
		t.Fatalf("list: %v %d", err, len(list))
	}
	byID := map[string]wshrpc.BoardInfo{}
	for _, b := range list {
		byID[b.ID] = b
	}

	check := func(name string, got wshrpc.BoardInfo, questions int, about, st string, answered, active int64) {
		t.Helper()
		if got.Questions != questions || got.About != about || got.State != st || got.AnsweredTs != answered || got.ActiveTs != active {
			t.Errorf("%s: questions=%d about=%q state=%q answered=%d active=%d", name, got.Questions, got.About, got.State, got.AnsweredTs, got.ActiveTs)
		}
	}
	check("asks", byID[asks.ID], 2, "wavesrv", "asks", 150, 200)
	check("kept", byID[kept.ID], 1, "", "", 550, 550)
	check("failed", byID[failed.ID], 1, "", "failed", 0, 300)
	check("stale", byID[stale.ID], 1, "", "answering", 0, 50) // state() wins over the stale turn
	check("chosen", byID[chosen.ID], 1, "", "", 0, 10)
	check("bare1", byID[bare1.ID], 0, "", "", 0, 6)

	// a project or empty-kind about leaves About empty, whatever title the talk carries
	for _, kind := range []string{"project", ""} {
		if _, err := UpdateTalk(dir, bare1.ID, func(tk *wshrpc.BoardTalk) error {
			tk.About = wshrpc.BoardSource{Kind: kind, Title: "waveterm"}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		again, _ := List(dir, testChannel, state)
		for _, b := range again {
			if b.ID == bare1.ID && b.About != "" {
				t.Errorf("kind %q: About = %q, want empty", kind, b.About)
			}
		}
	}

	tied := []string{bare1.ID, bare2.ID}
	sort.Strings(tied)
	want := append([]string{kept.ID, failed.ID, asks.ID, stale.ID, chosen.ID}, tied...)
	for i, id := range want {
		if list[i].ID != id {
			t.Fatalf("order[%d] = %s, want %s (ActiveTs newest first, then id)", i, list[i].ID, id)
		}
	}

	// without state(), an answering turn nothing runs reads failed
	plain, _ := List(dir, testChannel, nil)
	for _, b := range plain {
		if b.ID == stale.ID && b.State != "failed" {
			t.Errorf("stale answering turn state = %q, want failed", b.State)
		}
	}
}
