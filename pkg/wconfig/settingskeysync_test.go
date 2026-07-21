// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

// TestSettingsKeysInSync guards the three places every settings key must appear together:
// the SettingsType struct (the source of truth), the generated ConfigKey_* constants in
// metaconsts.go, and the generated JSON schema. Both generated files are produced from
// SettingsType by `task generate`, so add a field to one place and forget the others and
// they silently drift. This fails when that happens, naming exactly what is out of sync.
//
// SettingsType is the pivot: schema-vs-struct and metaconsts-vs-struct together imply
// schema-vs-metaconsts, so a key added to any single one of the three trips the test.
func TestSettingsKeysInSync(t *testing.T) {
	structKeys := settingsStructKeys()
	if len(structKeys) == 0 {
		t.Fatal("no exported fields found on SettingsType")
	}
	assertSameKeys(t, "pkg/wconfig/metaconsts.go ConfigKey_* values", structKeys, configKeyConstValues(t))
	assertSameKeys(t, "schema/settings.json properties", structKeys, schemaSettingsKeys(t))
}

// settingsStructKeys mirrors gogen.GenerateMetaMapConsts exactly: the json tag (before the
// comma) per exported field, falling back to the field name when there is no json tag.
func settingsStructKeys() map[string]bool {
	keys := map[string]bool{}
	rt := reflect.TypeOf(SettingsType{})
	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		if field.PkgPath != "" { // skip unexported
			continue
		}
		tag := utilfn.GetJsonTag(field)
		if tag == "" {
			tag = field.Name
		}
		keys[tag] = true
	}
	return keys
}

// configKeyConstValues parses metaconsts.go (same package dir) and returns the string
// values of every ConfigKey_* constant. Reading the file on disk — rather than
// re-deriving from SettingsType — is what makes a stale generated file detectable.
func configKeyConstValues(t *testing.T) map[string]bool {
	const path = "metaconsts.go"
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	keys := map[string]bool{}
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.CONST {
			continue
		}
		for _, spec := range gd.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, name := range vs.Names {
				if !strings.HasPrefix(name.Name, "ConfigKey_") || i >= len(vs.Values) {
					continue
				}
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				val, err := strconv.Unquote(lit.Value)
				if err != nil {
					t.Fatalf("unquote %s value %q: %v", name.Name, lit.Value, err)
				}
				keys[val] = true
			}
		}
	}
	if len(keys) == 0 {
		t.Fatalf("no ConfigKey_* constants found in %s", path)
	}
	return keys
}

// schemaSettingsKeys reads schema/settings.json and returns the property keys declared
// under $defs.SettingsType.
func schemaSettingsKeys(t *testing.T) map[string]bool {
	path := filepath.Join(repoRoot(t), "schema", "settings.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc struct {
		Defs struct {
			SettingsType struct {
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"SettingsType"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	keys := map[string]bool{}
	for k := range doc.Defs.SettingsType.Properties {
		keys[k] = true
	}
	if len(keys) == 0 {
		t.Fatalf("no properties found under $defs.SettingsType in %s", path)
	}
	return keys
}

func assertSameKeys(t *testing.T, name string, want, got map[string]bool) {
	t.Helper()
	var missing, extra []string
	for k := range want {
		if !got[k] {
			missing = append(missing, k)
		}
	}
	for k := range got {
		if !want[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) > 0 {
		t.Errorf("%s is missing keys present in SettingsType: %v (edit SettingsType then run `task generate`)", name, missing)
	}
	if len(extra) > 0 {
		t.Errorf("%s has keys not in SettingsType: %v (add the field to SettingsType or remove the key, then run `task generate`)", name, extra)
	}
}

// repoRoot walks up from the test's working directory to the module root (the dir holding
// go.mod), so the test finds schema/settings.json regardless of where wconfig lives.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "go.mod")); statErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("go.mod not found walking up from %s", dir)
			return ""
		}
		dir = parent
	}
}
