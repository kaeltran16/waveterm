// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const testChannel = "chan-1"

func mustCreate(t *testing.T, dir, name string, now int64) wshrpc.BoardInfo {
	t.Helper()
	info, err := Create(dir, testChannel, name, now)
	if err != nil {
		t.Fatalf("create %q: %v", name, err)
	}
	return info
}

// writeRecord rewrites a board file with the given arc record, as the frontend's save would.
func writeRecord(t *testing.T, dir, id string, rec wshrpc.BoardArcRecord) {
	t.Helper()
	arc, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	body := `{"arc":` + string(arc) + `,"type":"excalidraw","version":2,"source":"arc","elements":[],"appState":{},"files":{}}`
	if err := os.WriteFile(boardPath(dir, id), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
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

	// never drawn: newest created first
	list, err := List(dir, testChannel, nil)
	if err != nil || len(list) != 2 || list[0].ID != b.ID || list[1].ID != a.ID {
		t.Fatalf("never-drawn order: %v %+v", err, list)
	}

	// a draw time moves a board ahead of never-drawn ones, and NewCount counts sources past seents
	writeRecord(t, dir, a.ID, wshrpc.BoardArcRecord{Name: "Auth flow", CreatedTs: 1000, SeenTs: 5000, Sources: []wshrpc.BoardArcSource{
		{Key: "agent:t1", DrawnTs: 4000}, {Key: "agent:t2", DrawnTs: 6000}, {Key: "agent:t3", DrawnTs: 7000},
	}})
	state := func(id string) string {
		if id == a.ID {
			return "drawing"
		}
		return ""
	}
	list, err = List(dir, testChannel, state)
	if err != nil || len(list) != 2 || list[0].ID != a.ID {
		t.Fatalf("drawn order: %v %+v", err, list)
	}
	got := list[0]
	if got.Groups != 3 || got.LastDrawnTs != 7000 || got.NewCount != 2 || got.State != "drawing" || list[1].State != "" {
		t.Fatalf("list row: %+v", got)
	}
	if !filepath.IsAbs(got.Path) || filepath.Base(got.Path) != a.ID+".excalidraw" {
		t.Fatalf("path: %q", got.Path)
	}

	read, err := Read(dir, testChannel, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if read.Arc.Name != "Auth flow" || len(read.Arc.Sources) != 3 || read.Rev == "" || read.Info.ID != a.ID {
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
	_, err := Create(dir, testChannel, "   ", 1)
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
	draw := wshrpc.BoardDraw{ID: uuid.NewString(), BoardId: "", Ts: 1}
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
		draw.BoardId = id
		if err := PutDraw(dir, draw); err == nil {
			t.Errorf("PutDraw(%q) should refuse", id)
		}
		if id != "" { // an empty board id means every board
			if _, err := Draws(dir, id); err == nil {
				t.Errorf("Draws(%q) should refuse", id)
			}
		}
		if err := AckDraw(dir, id, uuid.NewString()); err == nil {
			t.Errorf("AckDraw(%q) should refuse", id)
		}
		if _, _, err := Previous(dir, id, "k"); err == nil {
			t.Errorf("Previous(%q) should refuse", id)
		}
	}
	if err := AckDraw(dir, "7c1e0b4f", "../../x"); err == nil {
		t.Error("AckDraw should refuse a draw id that is not a uuid")
	}
	if err := PutDraw(dir, wshrpc.BoardDraw{ID: "../x", BoardId: "7c1e0b4f"}); err == nil {
		t.Error("PutDraw should refuse a draw id that is not a uuid")
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

func newDraw(board, key string, ts int64, skeleton string, cursor int64) wshrpc.BoardDraw {
	return wshrpc.BoardDraw{ID: uuid.NewString(), ChannelId: testChannel, BoardId: board, SourceKey: key, Skeleton: skeleton, CursorTs: cursor, Ts: ts}
}

func TestBoardStoreInbox(t *testing.T) {
	dir := t.TempDir()
	a := mustCreate(t, dir, "A", 1)
	b := mustCreate(t, dir, "B", 2)
	older := newDraw(a.ID, "agent:t1", 100, `[{"id":"old"}]`, 10)
	newer := newDraw(a.ID, "agent:t1", 200, `[{"id":"new"}]`, 20)
	other := newDraw(b.ID, "run:r1", 150, `[]`, 0)
	for _, d := range []wshrpc.BoardDraw{newer, older, other} { // written out of order
		if err := PutDraw(dir, d); err != nil {
			t.Fatal(err)
		}
	}

	got, err := Draws(dir, a.ID)
	if err != nil || len(got) != 2 || got[0].ID != older.ID || got[1].ID != newer.ID {
		t.Fatalf("oldest first: %v %+v", err, got)
	}
	if got[1].Skeleton != newer.Skeleton || got[1].CursorTs != 20 {
		t.Fatalf("round trip: %+v", got[1])
	}
	all, err := Draws(dir, "")
	if err != nil || len(all) != 3 || all[0].ID != older.ID || all[1].ID != other.ID || all[2].ID != newer.ID {
		t.Fatalf("every board, oldest first: %v %+v", err, all)
	}

	// the inbox wins over the file's source entry
	writeRecord(t, dir, a.ID, wshrpc.BoardArcRecord{Name: "A", CreatedTs: 1, Sources: []wshrpc.BoardArcSource{
		{Key: "agent:t1", Skeleton: `[{"id":"file"}]`, CursorTs: 5},
	}})
	if sk, cur, err := Previous(dir, a.ID, "agent:t1"); err != nil || sk != newer.Skeleton || cur != 20 {
		t.Fatalf("previous from inbox: %q %d %v", sk, cur, err)
	}
	if err := AckDraw(dir, a.ID, newer.ID); err != nil {
		t.Fatal(err)
	}
	if sk, cur, _ := Previous(dir, a.ID, "agent:t1"); sk != older.Skeleton || cur != 10 {
		t.Fatalf("previous after ack: %q %d", sk, cur)
	}
	if err := AckDraw(dir, a.ID, older.ID); err != nil {
		t.Fatal(err)
	}
	if sk, cur, _ := Previous(dir, a.ID, "agent:t1"); sk != `[{"id":"file"}]` || cur != 5 {
		t.Fatalf("previous from file: %q %d", sk, cur)
	}
	if sk, cur, err := Previous(dir, a.ID, "agent:other"); err != nil || sk != "" || cur != 0 {
		t.Fatalf("unknown source: %q %d %v", sk, cur, err)
	}
	// an empty id must not fall through to another board's inbox draw for the same key
	if sk, _, err := Previous(dir, "", "run:r1"); err == nil || sk != "" {
		t.Fatalf("empty board id read another board's inbox: %q %v", sk, err)
	}

	if err := AckDraw(dir, a.ID, newer.ID); err != nil {
		t.Fatalf("acking a missing draw: %v", err)
	}
	if err := AckDraw(dir, "7c1e0b4f", uuid.NewString()); err != nil {
		t.Fatalf("acking on a board with no inbox: %v", err)
	}
	if left, _ := Draws(dir, a.ID); len(left) != 0 {
		t.Fatalf("left: %+v", left)
	}
	if none, err := Draws(dir, "7c1e0b4f"); err != nil || len(none) != 0 {
		t.Fatalf("no inbox: %v %v", none, err)
	}
}
