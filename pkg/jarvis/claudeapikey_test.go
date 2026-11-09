// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const testApiKey = "sk-ant-x-abcd"

// apiKeyFixture is an account fixture plus a wsh, a config dir and a validator that never touch the
// network or the real files.
type apiKeyFixture struct {
	accountFixture
	wsh       string
	configDir string
	validated []string
}

func withClaudeApiKeyFiles(t *testing.T, creds, cfg string) *apiKeyFixture {
	t.Helper()
	f := &apiKeyFixture{accountFixture: withClaudeAccountFiles(t, creds, cfg)}
	dir := t.TempDir()
	f.wsh = filepath.Join(dir, "home", ".arc", "bin", "wsh.exe")
	f.configDir = filepath.Join(dir, "config")
	if err := os.MkdirAll(filepath.Dir(f.wsh), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.wsh, []byte("wsh"), 0o755); err != nil {
		t.Fatal(err)
	}
	oldWsh, oldDir, oldValidate := claudeHelperWsh, claudeHelperConfigDir, validateClaudeApiKey
	claudeHelperWsh = func() string { return f.wsh }
	claudeHelperConfigDir = func() string { return f.configDir }
	validateClaudeApiKey = func(ctx context.Context, key string) error {
		f.validated = append(f.validated, key)
		return nil
	}
	t.Cleanup(func() {
		claudeHelperWsh, claudeHelperConfigDir, validateClaudeApiKey = oldWsh, oldDir, oldValidate
	})
	return f
}

// wantHelper is the apiKeyHelper value this instance writes.
func (f *apiKeyFixture) wantHelper() string {
	return `"` + f.wsh + `" claude-api-key --config-dir "` + f.configDir + `"`
}

func (f *apiKeyFixture) writeSettings(t *testing.T, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(f.settingsPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.settingsPath, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *apiKeyFixture) settingsHelper(t *testing.T) (string, bool) {
	t.Helper()
	raw, ok := readObject(t, f.settingsPath)[claudeApiKeyHelperKey]
	if !ok {
		return "", false
	}
	var helper string
	if err := json.Unmarshal(raw, &helper); err != nil {
		t.Fatalf("apiKeyHelper = %s: %v", raw, err)
	}
	return helper, true
}

func decodeFile(t *testing.T, path string) map[string]any {
	t.Helper()
	var obj map[string]any
	if err := json.Unmarshal([]byte(readBytes(t, path)), &obj); err != nil {
		t.Fatal(err)
	}
	return obj
}

func listApiKey(t *testing.T) apiKeyState {
	t.Helper()
	rtn, err := ListClaudeAccounts()
	if err != nil {
		t.Fatal(err)
	}
	return apiKeyState{rtn.ApiKey.Saved, rtn.ApiKey.Last4, rtn.ApiKey.Active}
}

type apiKeyState struct {
	Saved  bool
	Last4  string
	Active bool
}

func TestSaveClaudeApiKeyTrimsValidatesStores(t *testing.T) {
	f := withClaudeApiKeyFiles(t, "", "")
	if err := SaveClaudeApiKey(context.Background(), "  "+testApiKey+"\n"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.validated, []string{testApiKey}) {
		t.Errorf("validator saw %q, want [%q]", f.validated, testApiKey)
	}
	if got := f.store[ClaudeApiKeySecretName]; got != testApiKey {
		t.Errorf("stored key = %q, want %q", got, testApiKey)
	}
	if got, want := listApiKey(t), (apiKeyState{Saved: true, Last4: "abcd"}); got != want {
		t.Errorf("apikey = %+v, want %+v", got, want)
	}
}

func TestSaveClaudeApiKeyRefused(t *testing.T) {
	f := withClaudeApiKeyFiles(t, "", "")
	validateClaudeApiKey = func(ctx context.Context, key string) error {
		f.validated = append(f.validated, key)
		return errors.New("invalid x-api-key")
	}
	err := SaveClaudeApiKey(context.Background(), testApiKey)
	if err == nil || !strings.Contains(err.Error(), "invalid x-api-key") {
		t.Fatalf("err = %v, want the validator's", err)
	}
	if _, ok := f.store[ClaudeApiKeySecretName]; ok {
		t.Error("a refused key was stored")
	}

	f.validated = nil
	for _, key := range []string{"", "  \n"} {
		if err := SaveClaudeApiKey(context.Background(), key); err == nil {
			t.Errorf("saving %q succeeded", key)
		}
	}
	if len(f.validated) != 0 {
		t.Errorf("validator called for a blank key: %q", f.validated)
	}
	if _, ok := f.store[ClaudeApiKeySecretName]; ok {
		t.Error("a blank key was stored")
	}
}

func TestDefaultValidatorAgainstServer(t *testing.T) {
	var status int
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" || r.URL.RawQuery != "limit=1" {
			t.Errorf("request = %s %s, want GET /v1/models?limit=1", r.Method, r.URL)
		}
		if got := r.Header.Get("x-api-key"); got != testApiKey {
			t.Errorf("x-api-key = %q", got)
		}
		if got := r.Header.Get("anthropic-version"); got != "2023-06-01" {
			t.Errorf("anthropic-version = %q", got)
		}
		w.WriteHeader(status)
		w.Write([]byte(body))
	}))
	oldBase := anthropicAPIBase
	anthropicAPIBase = srv.URL
	t.Cleanup(func() { anthropicAPIBase = oldBase })

	status, body = http.StatusOK, `{"data":[]}`
	if err := defaultValidateClaudeApiKey(context.Background(), testApiKey); err != nil {
		t.Errorf("200: err = %v", err)
	}

	status, body = http.StatusUnauthorized, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`
	if err := defaultValidateClaudeApiKey(context.Background(), testApiKey); err == nil || !strings.Contains(err.Error(), "invalid x-api-key") {
		t.Errorf("401: err = %v, want one containing the API's message", err)
	}

	srv.Close()
	if err := defaultValidateClaudeApiKey(context.Background(), testApiKey); err == nil || !strings.Contains(err.Error(), "could not reach the Anthropic API") {
		t.Errorf("closed server: err = %v, want could not reach the Anthropic API", err)
	}
}

func TestSwitchToApiKeyKeepsOtherKeys(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeApiKeyFiles(t, creds, cfg)
	f.store[ClaudeApiKeySecretName] = testApiKey
	const orig = `{"model":"opus","hooks":{"Stop":[]}}`
	f.writeSettings(t, orig)
	want := decodeFile(t, f.settingsPath)

	if err := SwitchToClaudeApiKey(); err != nil {
		t.Fatal(err)
	}
	got := decodeFile(t, f.settingsPath)
	if got[claudeApiKeyHelperKey] != f.wantHelper() {
		t.Errorf("apiKeyHelper = %v, want %s", got[claudeApiKeyHelperKey], f.wantHelper())
	}
	delete(got, claudeApiKeyHelperKey)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("other keys = %v, want %v", got, want)
	}
	if !strings.Contains(readBytes(t, f.settingsPath), "\n  \"") {
		t.Errorf("settings not written with 2-space indent:\n%s", readBytes(t, f.settingsPath))
	}

	if err := SwitchClaudeAccount(uuidA); err != nil {
		t.Fatal(err)
	}
	if got := decodeFile(t, f.settingsPath); !reflect.DeepEqual(got, want) {
		t.Errorf("after switching back, settings = %v, want %v", got, want)
	}
	if readBytes(t, f.credPath) != creds || readBytes(t, f.cfgPath) != cfg {
		t.Error("switching back to the live account rewrote its login")
	}
}

func TestSwitchToApiKeyMissingSettingsFile(t *testing.T) {
	f := withClaudeApiKeyFiles(t, "", "")
	f.store[ClaudeApiKeySecretName] = testApiKey
	if err := SwitchToClaudeApiKey(); err != nil {
		t.Fatal(err)
	}
	got := decodeFile(t, f.settingsPath)
	if len(got) != 1 || got[claudeApiKeyHelperKey] != f.wantHelper() {
		t.Errorf("settings = %v, want only apiKeyHelper %s", got, f.wantHelper())
	}
}

func TestSwitchToApiKeyInvalidSettings(t *testing.T) {
	f := withClaudeApiKeyFiles(t, "", "")
	f.store[ClaudeApiKeySecretName] = testApiKey
	const bad = `{not json`
	f.writeSettings(t, bad)
	err := SwitchToClaudeApiKey()
	if err == nil || !strings.Contains(err.Error(), f.settingsPath) {
		t.Fatalf("err = %v, want one naming %s", err, f.settingsPath)
	}
	if got := readBytes(t, f.settingsPath); got != bad {
		t.Errorf("settings changed: %s", got)
	}
}

func TestSwitchToApiKeyRefusesForeignHelper(t *testing.T) {
	cases := []struct {
		name, settings, wantErr string
	}{
		{"foreign command", `{"apiKeyHelper":"/bin/vault-key"}`, "/bin/vault-key"},
		{"number", `{"apiKeyHelper":42}`, "42"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := withClaudeApiKeyFiles(t, "", "")
			f.store[ClaudeApiKeySecretName] = testApiKey
			f.writeSettings(t, tc.settings)
			err := SwitchToClaudeApiKey()
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want a refusal naming %s", err, tc.wantErr)
			}
			if got := readBytes(t, f.settingsPath); got != tc.settings {
				t.Errorf("settings changed: %s", got)
			}
		})
	}
	t.Run("null", func(t *testing.T) {
		f := withClaudeApiKeyFiles(t, "", "")
		f.store[ClaudeApiKeySecretName] = testApiKey
		f.writeSettings(t, `{"apiKeyHelper":null,"model":"opus"}`)
		if err := SwitchToClaudeApiKey(); err != nil {
			t.Fatal(err)
		}
		if helper, _ := f.settingsHelper(t); helper != f.wantHelper() {
			t.Errorf("apiKeyHelper = %q, want %q", helper, f.wantHelper())
		}
	})
}

func TestSwitchToApiKeyNeedsKeyAndWsh(t *testing.T) {
	f := withClaudeApiKeyFiles(t, "", "")
	if err := SwitchToClaudeApiKey(); err == nil {
		t.Error("switch succeeded with no saved key")
	}
	f.store[ClaudeApiKeySecretName] = testApiKey
	missing := filepath.Join(t.TempDir(), "gone", "wsh.exe")
	claudeHelperWsh = func() string { return missing }
	err := SwitchToClaudeApiKey()
	if err == nil || !strings.Contains(err.Error(), missing) {
		t.Fatalf("err = %v, want one naming %s", err, missing)
	}
	if _, err := os.Stat(f.settingsPath); !os.IsNotExist(err) {
		t.Errorf("a refused switch wrote settings: stat err = %v", err)
	}
}

func TestOtherArcHelperCountsAsArcs(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeApiKeyFiles(t, creds, cfg)
	f.store[ClaudeApiKeySecretName] = testApiKey
	saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(30), 1)
	other, _ := json.Marshal(map[string]string{claudeApiKeyHelperKey: `"C:\x\wsh-0.9.1-windows.x64.exe" claude-api-key --config-dir "C:\other"`})
	f.writeSettings(t, string(other))

	if !listApiKey(t).Active {
		t.Error("the other instance's helper does not count as active")
	}
	if err := SwitchToClaudeApiKey(); err != nil {
		t.Fatal(err)
	}
	if helper, _ := f.settingsHelper(t); helper != f.wantHelper() {
		t.Errorf("apiKeyHelper = %q, want this instance's %q", helper, f.wantHelper())
	}

	f.writeSettings(t, string(other))
	if err := SwitchClaudeAccount(uuidB); err != nil {
		t.Fatal(err)
	}
	if helper, ok := f.settingsHelper(t); ok {
		t.Errorf("account switch left apiKeyHelper %q", helper)
	}
}

func TestIsArcApiKeyHelper(t *testing.T) {
	cases := map[string]bool{
		`"C:\Users\me\.arc\bin\wsh.exe" claude-api-key --config-dir "C:\cfg"`: true,
		`/home/me/.arc/bin/wsh claude-api-key --config-dir /cfg`:              true,
		`"C:\x\WSH-0.9.1-windows.x64.exe" claude-api-key`:                     true,
		`"C:\x\wsh.exe" agent-hook`:                                           false,
		`/bin/vault-key claude-api-key`:                                       false,
		`"C:\x\wsh.exe"`:                                                      false,
		``:                                                                    false,
	}
	for cmd, want := range cases {
		if got := isArcApiKeyHelper(cmd); got != want {
			t.Errorf("isArcApiKeyHelper(%q) = %v, want %v", cmd, got, want)
		}
	}
}

func TestApiKeyActiveHidesAccountActive(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeApiKeyFiles(t, creds, cfg)
	f.store[ClaudeApiKeySecretName] = testApiKey
	if err := SwitchToClaudeApiKey(); err != nil {
		t.Fatal(err)
	}
	rtn, err := ListClaudeAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if !rtn.ApiKey.Active || !rtn.ApiKey.Saved || rtn.ApiKey.Last4 != "abcd" {
		t.Errorf("apikey = %+v, want saved, active, last4 abcd", rtn.ApiKey)
	}
	if len(rtn.Accounts) != 1 || !rtn.Accounts[0].Live || rtn.Accounts[0].Active {
		t.Errorf("accounts = %+v, want the live account not active", rtn.Accounts)
	}
}

func TestAccountSwitchFailureRestoresHelper(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeApiKeyFiles(t, creds, cfg)
	f.store[ClaudeApiKeySecretName] = testApiKey
	saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(30), 1)
	if err := SwitchToClaudeApiKey(); err != nil {
		t.Fatal(err)
	}
	blockAtomicWrite(t, f.credPath)

	err := SwitchClaudeAccount(uuidB)
	if err == nil || !strings.Contains(err.Error(), claudeCredentialsFile) {
		t.Fatalf("err = %v, want the credentials write's", err)
	}
	if helper, _ := f.settingsHelper(t); helper != f.wantHelper() {
		t.Errorf("apiKeyHelper = %q after a failed account switch, want %q", helper, f.wantHelper())
	}
	if readBytes(t, f.credPath) != creds {
		t.Error("credentials changed by a failed switch")
	}
}

func TestRemoveClaudeApiKey(t *testing.T) {
	f := withClaudeApiKeyFiles(t, "", "")
	f.store[ClaudeApiKeySecretName] = testApiKey
	if err := SwitchToClaudeApiKey(); err != nil {
		t.Fatal(err)
	}
	err := RemoveClaudeApiKey()
	if err == nil || !strings.Contains(err.Error(), "switch to") {
		t.Fatalf("removing the active key: err = %v, want a refusal saying to switch to an account first", err)
	}
	if _, ok := f.store[ClaudeApiKeySecretName]; !ok {
		t.Fatal("a refused remove deleted the key")
	}

	f.writeSettings(t, `{}`)
	if err := RemoveClaudeApiKey(); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.store[ClaudeApiKeySecretName]; ok {
		t.Error("the key is still saved")
	}
	if listApiKey(t).Saved {
		t.Error("list still reports the key saved")
	}
}
