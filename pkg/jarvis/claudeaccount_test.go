// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
)

type fakeAccountStore map[string]string

func (f fakeAccountStore) Get(name string) (string, bool, error) {
	v, ok := f[name]
	return v, ok, nil
}
func (f fakeAccountStore) Set(name, value string) error { f[name] = value; return nil }
func (f fakeAccountStore) Delete(name string) error     { delete(f, name); return nil }
func (f fakeAccountStore) Names() ([]string, error) {
	names := make([]string, 0, len(f))
	for n := range f {
		names = append(names, n)
	}
	return names, nil
}

type accountFixture struct {
	credPath string
	cfgPath  string
	store    fakeAccountStore
}

// withClaudeAccountFiles points the credentials, config and secret-store seams at throwaway state. An
// empty contents string leaves that file absent.
func withClaudeAccountFiles(t *testing.T, creds, cfg string) accountFixture {
	t.Helper()
	cfgPath := withTempClaudeConfig(t, cfg)
	credPath := filepath.Join(t.TempDir(), ".claude", claudeCredentialsFile)
	if creds != "" {
		if err := os.MkdirAll(filepath.Dir(credPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(credPath, []byte(creds), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	oldCred, oldStore := claudeCredentialsPath, claudeAccountSecrets
	store := fakeAccountStore{}
	claudeCredentialsPath = func() (string, error) { return credPath, nil }
	claudeAccountSecrets = store
	t.Cleanup(func() { claudeCredentialsPath, claudeAccountSecrets = oldCred, oldStore })
	return accountFixture{credPath: credPath, cfgPath: cfgPath, store: store}
}

func testOauth(refresh string, refreshExpiresAt int64) string {
	return fmt.Sprintf(`{"accessToken":"at-%s","refreshToken":"%s","expiresAt":1,"refreshTokenExpiresAt":%d,"scopes":["user:inference"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}`,
		refresh, refresh, refreshExpiresAt)
}

func testAccount(uuid, email string) string {
	return fmt.Sprintf(`{"accountUuid":"%s","emailAddress":"%s","organizationName":"Org %s"}`, uuid, email, uuid)
}

func dayFromNow(days int) int64 {
	return time.Now().Add(time.Duration(days) * 24 * time.Hour).UnixMilli()
}

const (
	uuidA = "aaaaaaaa-0000-4000-8000-00000000000a"
	uuidB = "bbbbbbbb-0000-4000-8000-00000000000b"
	uuidC = "cccccccc-0000-4000-8000-00000000000c"
)

// liveFiles is a logged-in pair for account A, with keys Arc does not own in both files.
func liveFiles(refresh string) (string, string) {
	creds := fmt.Sprintf(`{"claudeAiOauth":%s,"mcpOAuth":{"github|abc":{"accessToken":"mcp-tok"}},"otherKey":[1,2]}`,
		testOauth(refresh, dayFromNow(30)))
	cfg := fmt.Sprintf(`{"numStartups":7,"projects":{"C:/x":{"hasTrustDialogAccepted":true}},"oauthAccount":%s}`,
		testAccount(uuidA, "a@example.com"))
	return creds, cfg
}

func saveAccount(t *testing.T, store fakeAccountStore, uuid, email, refresh string, refreshExpiresAt, lastUsed int64) {
	t.Helper()
	value := fmt.Sprintf(`{"oauth":%s,"account":%s,"lastusedts":%d}`, testOauth(refresh, refreshExpiresAt), testAccount(uuid, email), lastUsed)
	store[claudeAccountSecretName(uuid)] = value
}

func readObject(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	obj, err := readJSONObjectFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return obj
}

func savedView(t *testing.T, store fakeAccountStore, uuid string) *claudeAccountView {
	t.Helper()
	value, ok := store[claudeAccountSecretName(uuid)]
	if !ok {
		t.Fatalf("no saved secret for %s", uuid)
	}
	v, err := parseSavedClaudeAccount(value)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func assertJSONEqual(t *testing.T, label string, got json.RawMessage, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	gb, _ := json.Marshal(g)
	wb, _ := json.Marshal(w)
	if string(gb) != string(wb) {
		t.Errorf("%s = %s, want %s", label, gb, wb)
	}
}

func readBytes(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestClaudeAccountCaptureSavesLiveLogin(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeAccountFiles(t, creds, cfg)
	before := time.Now().UnixMilli()
	rtn, err := ListClaudeAccounts()
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now().UnixMilli()

	name := "claudeacct_aaaaaaaa_0000_4000_8000_00000000000a"
	value, ok := f.store[name]
	if !ok {
		t.Fatalf("secret %s not saved; store = %v", name, f.store)
	}
	if strings.ContainsAny(value, "\r\n") {
		t.Errorf("secret value is not one line: %q", value)
	}
	v := savedView(t, f.store, uuidA)
	assertJSONEqual(t, "oauth", v.saved.OAuth, string(readObject(t, f.credPath)[claudeOauthKey]))
	assertJSONEqual(t, "account", v.saved.Account, testAccount(uuidA, "a@example.com"))
	if v.saved.LastUsedTs < before || v.saved.LastUsedTs > after {
		t.Errorf("lastusedts = %d, want within [%d, %d]", v.saved.LastUsedTs, before, after)
	}

	if !rtn.LoggedIn || len(rtn.Accounts) != 1 {
		t.Fatalf("list = %+v, want logged in with one account", rtn)
	}
	got := rtn.Accounts[0]
	if got.AccountUuid != uuidA || got.Email != "a@example.com" || got.OrgName != "Org "+uuidA || got.Plan != "max" || !got.Active || got.Expired {
		t.Errorf("account = %+v", got)
	}
}

func TestClaudeAccountCaptureWithoutLoginIsNoop(t *testing.T) {
	cases := map[string][2]string{
		"no files":       {"", ""},
		"no identity":    {`{"claudeAiOauth":` + testOauth("r1", 0) + `}`, `{"numStartups":1}`},
		"no tokens":      {`{"mcpOAuth":{}}`, `{"oauthAccount":` + testAccount(uuidA, "a@example.com") + `}`},
		"identity no id": {`{"claudeAiOauth":` + testOauth("r1", 0) + `}`, `{"oauthAccount":{"emailAddress":"a@example.com"}}`},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			f := withClaudeAccountFiles(t, files[0], files[1])
			rtn, err := ListClaudeAccounts()
			if err != nil {
				t.Fatal(err)
			}
			if rtn.LoggedIn || len(rtn.Accounts) != 0 || len(f.store) != 0 {
				t.Errorf("list = %+v, store = %v; want nothing", rtn, f.store)
			}
		})
	}
}

func TestClaudeAccountListFlags(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeAccountFiles(t, creds, cfg)
	now := time.Now().UnixMilli()
	saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(-1), now-2000)
	saveAccount(t, f.store, uuidC, "c@example.com", "rc", 0, now-1000)
	f.store["unrelated_secret"] = "x"

	rtn, err := ListClaudeAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if len(rtn.Accounts) != 3 {
		t.Fatalf("accounts = %+v, want 3", rtn.Accounts)
	}
	want := []struct {
		uuid            string
		active, expired bool
	}{{uuidA, true, false}, {uuidC, false, false}, {uuidB, false, true}}
	for i, w := range want {
		got := rtn.Accounts[i]
		if got.AccountUuid != w.uuid || got.Active != w.active || got.Expired != w.expired {
			t.Errorf("accounts[%d] = %+v, want uuid %s active %v expired %v", i, got, w.uuid, w.active, w.expired)
		}
	}
}

func TestClaudeAccountSwitchKeepsOtherKeys(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeAccountFiles(t, creds, cfg)
	saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(30), 1)

	if err := SwitchClaudeAccount(uuidB); err != nil {
		t.Fatal(err)
	}
	gotCreds := readObject(t, f.credPath)
	assertJSONEqual(t, "claudeAiOauth", gotCreds[claudeOauthKey], string(savedView(t, f.store, uuidB).saved.OAuth))
	assertJSONEqual(t, "mcpOAuth", gotCreds["mcpOAuth"], `{"github|abc":{"accessToken":"mcp-tok"}}`)
	assertJSONEqual(t, "otherKey", gotCreds["otherKey"], `[1,2]`)
	if len(gotCreds) != 3 {
		t.Errorf("credentials keys = %d, want 3", len(gotCreds))
	}

	gotCfg := readObject(t, f.cfgPath)
	assertJSONEqual(t, "oauthAccount", gotCfg[claudeOauthAccountKey], testAccount(uuidB, "b@example.com"))
	assertJSONEqual(t, "numStartups", gotCfg["numStartups"], `7`)
	assertJSONEqual(t, "projects", gotCfg["projects"], `{"C:/x":{"hasTrustDialogAccepted":true}}`)
	if len(gotCfg) != 3 {
		t.Errorf("config keys = %d, want 3", len(gotCfg))
	}

	rtn, err := ListClaudeAccounts()
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range rtn.Accounts {
		if a.Active != (a.AccountUuid == uuidB) {
			t.Errorf("after switch, %s active = %v", a.AccountUuid, a.Active)
		}
	}
}

func TestClaudeAccountSwitchCapturesLiveLoginFirst(t *testing.T) {
	creds, cfg := liveFiles("rotated")
	f := withClaudeAccountFiles(t, creds, cfg)
	// a stale saved copy of the live account: its refresh token has rotated since
	saveAccount(t, f.store, uuidA, "a@example.com", "stale", dayFromNow(30), 1)
	saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(30), 1)

	if err := SwitchClaudeAccount(uuidB); err != nil {
		t.Fatal(err)
	}
	var oauth struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.Unmarshal(savedView(t, f.store, uuidA).saved.OAuth, &oauth); err != nil {
		t.Fatal(err)
	}
	if oauth.RefreshToken != "rotated" {
		t.Errorf("saved refresh token for the previous account = %q, want the live %q", oauth.RefreshToken, "rotated")
	}
}

func TestClaudeAccountSwitchRefusals(t *testing.T) {
	cases := []struct {
		name    string
		target  string
		wantErr string
	}{
		{"expired", uuidB, "b@example.com"},
		{"unknown", uuidC, uuidC},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, cfg := liveFiles("r1")
			f := withClaudeAccountFiles(t, creds, cfg)
			saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(-1), 1)
			err := SwitchClaudeAccount(tc.target)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want one naming %s", err, tc.wantErr)
			}
			if got := readBytes(t, f.credPath); got != creds {
				t.Errorf("credentials changed: %s", got)
			}
			if got := readBytes(t, f.cfgPath); got != cfg {
				t.Errorf("config changed: %s", got)
			}
		})
	}
}

func TestClaudeAccountSwitchToActiveIsNoop(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeAccountFiles(t, creds, cfg)
	if err := SwitchClaudeAccount(uuidA); err != nil {
		t.Fatal(err)
	}
	if readBytes(t, f.credPath) != creds || readBytes(t, f.cfgPath) != cfg {
		t.Error("switching to the active account rewrote a file")
	}
}

// blockAtomicWrite makes fileutil.AtomicWriteFile on path fail: its temp file's name is taken by a
// non-empty directory, while reads of path itself still succeed.
func blockAtomicWrite(t *testing.T, path string) {
	t.Helper()
	blocker := path + fileutil.TempFileSuffix
	if err := os.MkdirAll(blocker, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocker, "keep"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeAccountSwitchRestoresCredentialsOnConfigFailure(t *testing.T) {
	t.Run("existing credentials", func(t *testing.T) {
		creds, cfg := liveFiles("r1")
		f := withClaudeAccountFiles(t, creds, cfg)
		saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(30), 1)
		blockAtomicWrite(t, f.cfgPath)

		err := SwitchClaudeAccount(uuidB)
		if err == nil || !strings.Contains(err.Error(), f.cfgPath) {
			t.Fatalf("err = %v, want one naming %s", err, f.cfgPath)
		}
		if got := readBytes(t, f.credPath); got != creds {
			t.Errorf("credentials not restored:\n got %s\nwant %s", got, creds)
		}
		if got := readBytes(t, f.cfgPath); got != cfg {
			t.Errorf("config changed: %s", got)
		}
	})
	t.Run("no credentials before", func(t *testing.T) {
		f := withClaudeAccountFiles(t, "", `{"numStartups":1}`)
		saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(30), 1)
		blockAtomicWrite(t, f.cfgPath)

		if err := SwitchClaudeAccount(uuidB); err == nil {
			t.Fatal("switch succeeded with an unwritable config")
		}
		if _, err := os.Stat(f.credPath); !os.IsNotExist(err) {
			t.Errorf("credentials file left behind: stat err = %v", err)
		}
	})
}

func TestClaudeAccountRemove(t *testing.T) {
	creds, cfg := liveFiles("r1")
	f := withClaudeAccountFiles(t, creds, cfg)
	saveAccount(t, f.store, uuidA, "a@example.com", "r1", dayFromNow(30), 1)
	saveAccount(t, f.store, uuidB, "b@example.com", "rb", dayFromNow(30), 1)

	if err := RemoveClaudeAccount(uuidB); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.store[claudeAccountSecretName(uuidB)]; ok {
		t.Error("removed account's secret is still saved")
	}
	err := RemoveClaudeAccount(uuidA)
	if err == nil || !strings.Contains(err.Error(), "a@example.com") {
		t.Fatalf("removing the active account: err = %v, want a refusal naming it", err)
	}
	if _, ok := f.store[claudeAccountSecretName(uuidA)]; !ok {
		t.Error("refused remove still deleted the active account's secret")
	}
}
