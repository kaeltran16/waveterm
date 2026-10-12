// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Claude Code keeps one Claude.ai login at a time: the tokens under claudeAiOauth in
// <config dir>/.credentials.json, the identity under oauthAccount in the user config file. Arc saves
// every login it reads into its secret store, so switching accounts is writing a saved pair back.

const (
	claudeCredentialsFile     = ".credentials.json"
	claudeOauthKey            = "claudeAiOauth"
	claudeOauthAccountKey     = "oauthAccount"
	claudeAccountSecretPrefix = "claudeacct_"
)

// claudeAccountStore is the slice of the secret store saved logins need. Package var so tests use an
// in-memory fake instead of the operator's secrets.enc.
type claudeAccountStore interface {
	Get(name string) (string, bool, error)
	Set(name, value string) error
	Delete(name string) error
	Names() ([]string, error)
}

type secretStoreAccounts struct{}

func (secretStoreAccounts) Get(name string) (string, bool, error) { return secretstore.GetSecret(name) }
func (secretStoreAccounts) Set(name, value string) error          { return secretstore.SetSecret(name, value) }
func (secretStoreAccounts) Delete(name string) error              { return secretstore.DeleteSecret(name) }
func (secretStoreAccounts) Names() ([]string, error)              { return secretstore.GetSecretNames() }

var claudeAccountSecrets claudeAccountStore = secretStoreAccounts{}

// claudeCredentialsPath resolves Claude Code's credentials file. Package var so tests never touch the
// real one.
var claudeCredentialsPath = defaultClaudeCredentialsPath

func defaultClaudeCredentialsPath() (string, error) {
	configDir := os.Getenv("CLAUDE_CONFIG_DIR")
	if configDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving home dir: %w", err)
		}
		configDir = filepath.Join(home, ".claude")
	}
	return filepath.Join(configDir, claudeCredentialsFile), nil
}

// claudeAccountMu serializes capture, switch and remove, so a capture never saves a half-switched pair.
var claudeAccountMu sync.Mutex

// savedClaudeAccount is a saved login's secret value. OAuth and Account are kept exactly as read.
type savedClaudeAccount struct {
	OAuth      json.RawMessage `json:"oauth"`
	Account    json.RawMessage `json:"account"`
	LastUsedTs int64           `json:"lastusedts"`
}

type claudeOauthFields struct {
	SubscriptionType      string `json:"subscriptionType"`
	RefreshTokenExpiresAt int64  `json:"refreshTokenExpiresAt"`
}

type claudeAccountFields struct {
	AccountUuid      string `json:"accountUuid"`
	EmailAddress     string `json:"emailAddress"`
	OrganizationName string `json:"organizationName"`
}

// claudeAccountView is a saved login with the fields Arc reads out of it.
type claudeAccountView struct {
	saved   savedClaudeAccount
	oauth   claudeOauthFields
	account claudeAccountFields
}

func (v *claudeAccountView) expired(nowMs int64) bool {
	return v.oauth.RefreshTokenExpiresAt > 0 && v.oauth.RefreshTokenExpiresAt < nowMs
}

// name is how an error refers to the account: its email, else its uuid.
func (v *claudeAccountView) name() string {
	if v.account.EmailAddress != "" {
		return v.account.EmailAddress
	}
	return v.account.AccountUuid
}

func claudeAccountSecretName(uuid string) string {
	return claudeAccountSecretPrefix + strings.ReplaceAll(uuid, "-", "_")
}

func parseSavedClaudeAccount(value string) (*claudeAccountView, error) {
	v := &claudeAccountView{}
	if err := json.Unmarshal([]byte(value), &v.saved); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(v.saved.OAuth, &v.oauth); err != nil {
		return nil, fmt.Errorf("oauth: %w", err)
	}
	if err := json.Unmarshal(v.saved.Account, &v.account); err != nil {
		return nil, fmt.Errorf("account: %w", err)
	}
	return v, nil
}

// loadClaudeAccount returns the saved login for uuid, or nil when none is saved.
func loadClaudeAccount(uuid string) (*claudeAccountView, error) {
	name := claudeAccountSecretName(uuid)
	value, ok, err := claudeAccountSecrets.Get(name)
	if err != nil {
		return nil, fmt.Errorf("reading saved Claude account %s: %w", uuid, err)
	}
	if !ok {
		return nil, nil
	}
	v, err := parseSavedClaudeAccount(value)
	if err != nil {
		return nil, fmt.Errorf("parsing saved Claude account %s: %w", uuid, err)
	}
	return v, nil
}

// claudeLiveLogin is the login Claude Code is using now.
type claudeLiveLogin struct {
	oauth   json.RawMessage
	account claudeAccountFields
	rawAcct json.RawMessage
}

// readJSONObjectFile reads a JSON object file; a missing or empty file is an empty object.
func readJSONObjectFile(path string) (map[string]json.RawMessage, error) {
	obj := map[string]json.RawMessage{}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return obj, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if err := unmarshalObject(data, &obj); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return obj, nil
}

func isJSONAbsent(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return trimmed == "" || trimmed == "null"
}

// readLiveClaudeLogin returns the live login, or nil when there is no Claude.ai login (no tokens, or no
// identity with an account uuid).
func readLiveClaudeLogin() (*claudeLiveLogin, error) {
	credPath, err := claudeCredentialsPath()
	if err != nil {
		return nil, err
	}
	creds, err := readJSONObjectFile(credPath)
	if err != nil {
		return nil, err
	}
	cfgPath, err := claudeConfigPath()
	if err != nil {
		return nil, err
	}
	cfg, err := readJSONObjectFile(cfgPath)
	if err != nil {
		return nil, err
	}
	oauth, rawAcct := creds[claudeOauthKey], cfg[claudeOauthAccountKey]
	if isJSONAbsent(oauth) || isJSONAbsent(rawAcct) {
		return nil, nil
	}
	var probe claudeOauthFields
	if err := json.Unmarshal(oauth, &probe); err != nil {
		return nil, fmt.Errorf("parsing %s in %s: %w", claudeOauthKey, credPath, err)
	}
	live := &claudeLiveLogin{oauth: oauth, rawAcct: rawAcct}
	if err := json.Unmarshal(rawAcct, &live.account); err != nil {
		return nil, fmt.Errorf("parsing %s in %s: %w", claudeOauthAccountKey, cfgPath, err)
	}
	if live.account.AccountUuid == "" {
		return nil, nil
	}
	return live, nil
}

// captureClaudeLogin saves the live login into its account's secret and returns it; nil when there is
// no live login. Caller holds claudeAccountMu.
func captureClaudeLogin() (*claudeLiveLogin, error) {
	live, err := readLiveClaudeLogin()
	if err != nil || live == nil {
		return live, err
	}
	// json.Marshal compacts the raw blobs, so the secret is one line.
	value, err := json.Marshal(savedClaudeAccount{OAuth: live.oauth, Account: live.rawAcct, LastUsedTs: time.Now().UnixMilli()})
	if err != nil {
		return nil, fmt.Errorf("encoding Claude account %s: %w", live.account.AccountUuid, err)
	}
	if err := claudeAccountSecrets.Set(claudeAccountSecretName(live.account.AccountUuid), string(value)); err != nil {
		return nil, fmt.Errorf("saving Claude account %s: %w", live.account.AccountUuid, err)
	}
	return live, nil
}

// ListClaudeAccounts captures the live login, then returns every saved account, most recently used
// first.
func ListClaudeAccounts() (*wshrpc.ClaudeAccountsRtnData, error) {
	claudeAccountMu.Lock()
	defer claudeAccountMu.Unlock()
	live, err := captureClaudeLogin()
	if err != nil {
		return nil, err
	}
	names, err := claudeAccountSecrets.Names()
	if err != nil {
		return nil, fmt.Errorf("listing saved Claude accounts: %w", err)
	}
	rtn := &wshrpc.ClaudeAccountsRtnData{LoggedIn: live != nil, Accounts: []wshrpc.ClaudeAccountInfo{}}
	nowMs := time.Now().UnixMilli()
	for _, name := range names {
		if !strings.HasPrefix(name, claudeAccountSecretPrefix) {
			continue
		}
		value, ok, err := claudeAccountSecrets.Get(name)
		if err != nil {
			return nil, fmt.Errorf("reading saved Claude account %s: %w", name, err)
		}
		if !ok {
			continue
		}
		v, err := parseSavedClaudeAccount(value)
		if err != nil {
			// one corrupt secret must not hide the others
			log.Printf("claudeaccount: skipping %s: %v\n", name, err)
			continue
		}
		rtn.Accounts = append(rtn.Accounts, wshrpc.ClaudeAccountInfo{
			AccountUuid: v.account.AccountUuid,
			Email:       v.account.EmailAddress,
			OrgName:     v.account.OrganizationName,
			Plan:        v.oauth.SubscriptionType,
			Active:      live != nil && v.account.AccountUuid == live.account.AccountUuid,
			Expired:     v.expired(nowMs),
			LastUsedTs:  v.saved.LastUsedTs,
		})
	}
	sort.Slice(rtn.Accounts, func(i, j int) bool {
		a, b := rtn.Accounts[i], rtn.Accounts[j]
		if a.LastUsedTs != b.LastUsedTs {
			return a.LastUsedTs > b.LastUsedTs
		}
		return a.AccountUuid < b.AccountUuid
	})
	return rtn, nil
}

// SwitchClaudeAccount makes the saved account uuid the live Claude.ai login. A failure leaves the
// current login as it was.
func SwitchClaudeAccount(uuid string) error {
	if uuid == "" {
		return fmt.Errorf("account uuid is required")
	}
	claudeAccountMu.Lock()
	defer claudeAccountMu.Unlock()
	// the live refresh token rotates while in use, so save it before writing over it
	live, err := captureClaudeLogin()
	if err != nil {
		return err
	}
	target, err := loadClaudeAccount(uuid)
	if err != nil {
		return err
	}
	if target == nil {
		return fmt.Errorf("no saved Claude account %s", uuid)
	}
	if target.expired(time.Now().UnixMilli()) {
		return fmt.Errorf("the sign-in for %s has expired; run /login with that account to save it again", target.name())
	}
	if live != nil && live.account.AccountUuid == uuid {
		return nil
	}
	credPath, err := claudeCredentialsPath()
	if err != nil {
		return err
	}
	restore, err := writeClaudeCredentials(credPath, target.saved.OAuth)
	if err != nil {
		return err
	}
	if err := writeClaudeOauthAccount(target.saved.Account); err != nil {
		if rerr := restore(); rerr != nil {
			return fmt.Errorf("%w; restoring %s also failed: %v", err, credPath, rerr)
		}
		return err
	}
	return nil
}

// writeClaudeCredentials sets claudeAiOauth in the credentials file, keeping every other key, and
// returns a func that puts the file back as it was.
func writeClaudeCredentials(path string, oauth json.RawMessage) (func() error, error) {
	perm := fs.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm()
	}
	orig, err := os.ReadFile(path)
	existed := err == nil
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	creds := map[string]json.RawMessage{}
	if err := unmarshalObject(orig, &creds); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	creds[claudeOauthKey] = oauth
	out, err := json.Marshal(creds)
	if err != nil {
		return nil, fmt.Errorf("encoding %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("creating dir for %s: %w", path, err)
	}
	if err := fileutil.AtomicWriteFile(path, out, perm); err != nil {
		return nil, fmt.Errorf("writing %s: %w", path, err)
	}
	restore := func() error {
		if existed {
			return fileutil.AtomicWriteFile(path, orig, perm)
		}
		return os.Remove(path)
	}
	return restore, nil
}

// writeClaudeOauthAccount sets oauthAccount in the user config file under Claude Code's own lock,
// keeping every other key.
func writeClaudeOauthAccount(account json.RawMessage) error {
	path, err := claudeConfigPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating dir for %s: %w", path, err)
	}
	unlock, err := lockClaudeConfig(path)
	if err != nil {
		return fmt.Errorf("locking %s: %w", path, err)
	}
	defer unlock()

	perm := fs.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm()
	}
	cfg, err := readJSONObjectFile(path)
	if err != nil {
		return err
	}
	cfg[claudeOauthAccountKey] = account
	// 2-space indent matches how Claude Code writes the file
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding %s: %w", path, err)
	}
	if err := fileutil.AtomicWriteFile(path, out, perm); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// RemoveClaudeAccount deletes a saved login. The active account cannot be removed.
func RemoveClaudeAccount(uuid string) error {
	if uuid == "" {
		return fmt.Errorf("account uuid is required")
	}
	claudeAccountMu.Lock()
	defer claudeAccountMu.Unlock()
	live, err := readLiveClaudeLogin()
	if err != nil {
		return err
	}
	if live != nil && live.account.AccountUuid == uuid {
		name := live.account.EmailAddress
		if name == "" {
			name = uuid
		}
		return fmt.Errorf("%s is the active Claude account; switch to another before removing it", name)
	}
	if err := claudeAccountSecrets.Delete(claudeAccountSecretName(uuid)); err != nil {
		return fmt.Errorf("removing saved Claude account %s: %w", uuid, err)
	}
	return nil
}
