// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package claudemod

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func readBack(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]any{}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestOptionsReadsWhatIsStored(t *testing.T) {
	path := writeFile(t, `{"pluginConfigs":{"arc-skim":{"options":{"dim":false}}}}`)
	got, err := optionsIn(path, "arc-skim")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, map[string]any{"dim": false}) {
		t.Fatalf("got %v", got)
	}
}

func TestOptionsReadsTheInlineEntry(t *testing.T) {
	path := writeFile(t, `{"pluginConfigs":{"arc-skim@inline":{"options":{"highlight":false}}}}`)
	got, err := optionsIn(path, "arc-skim")
	if err != nil {
		t.Fatal(err)
	}
	if got["highlight"] != false {
		t.Fatalf("got %v", got)
	}
}

func TestOptionsOfAMissingFileIsEmpty(t *testing.T) {
	got, err := optionsIn(filepath.Join(t.TempDir(), "settings.json"), "arc-skim")
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestSetOptionKeepsTheRestOfTheSettings(t *testing.T) {
	path := writeFile(t, `{"theme":"dark","env":{"A":"1"},"pluginConfigs":{"other":{"options":{"x":1}}}}`)
	if err := setOptionIn(path, "arc-skim", "highlight", false); err != nil {
		t.Fatal(err)
	}
	got := readBack(t, path)
	if got["theme"] != "dark" || got["env"].(map[string]any)["A"] != "1" {
		t.Fatalf("lost a setting: %v", got)
	}
	configs := got["pluginConfigs"].(map[string]any)
	if configs["other"] == nil {
		t.Fatalf("lost another plugin's entry: %v", configs)
	}
	opts := configs["arc-skim"].(map[string]any)["options"].(map[string]any)
	if opts["highlight"] != false {
		t.Fatalf("got %v", opts)
	}
}

func TestSetOptionWritesEveryEntryNamingThePlugin(t *testing.T) {
	path := writeFile(t, `{"pluginConfigs":{"arc-skim@inline":{"options":{"dim":true}}}}`)
	if err := setOptionIn(path, "arc-skim", "dim", false); err != nil {
		t.Fatal(err)
	}
	configs := readBack(t, path)["pluginConfigs"].(map[string]any)
	if _, ok := configs["arc-skim"]; ok {
		t.Fatalf("added a second entry: %v", configs)
	}
	if configs["arc-skim@inline"].(map[string]any)["options"].(map[string]any)["dim"] != false {
		t.Fatalf("got %v", configs)
	}
}

func TestSetOptionLeavesAnUnparseableFileAlone(t *testing.T) {
	path := writeFile(t, `{"theme": `)
	if err := setOptionIn(path, "arc-skim", "dim", false); err == nil {
		t.Fatal("wrote over a file it could not parse")
	}
	if b, _ := os.ReadFile(path); string(b) != `{"theme": ` {
		t.Fatalf("file changed: %q", b)
	}
}

func TestSetOptionRefusesWhatNoModDeclares(t *testing.T) {
	if err := SetOption("arc", "dim", false); err == nil {
		t.Fatal("wrote an option for a mod with none")
	}
	if err := SetOption("arc-skim", "model", false); err == nil {
		t.Fatal("wrote a field arc-skim does not declare")
	}
}
