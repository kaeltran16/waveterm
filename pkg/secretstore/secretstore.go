// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package secretstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	SecretsFileName   = "secrets.enc"
	WriteDebounceMs   = 1000
	InitRetryMs       = 1000
	SecretNamePattern = `^[A-Za-z][A-Za-z0-9_]*$`
	WriteTsKey        = "wave:writets"
)

var lock sync.Mutex
var writeMu sync.Mutex
var secrets = make(map[string]string)
var writeRequestChan chan struct{}
var initialized bool
var lastInitTryTime time.Time
var lastInitErr error
var secretNameRegexp = regexp.MustCompile(SecretNamePattern)

var errReadFile = errors.New("could not read secrets file")

// readSecretsFile errors name the path. A failure to read the bytes wraps errReadFile (and os.ErrNotExist
// when the file is absent); a file that is read but cannot be decrypted or parsed does not.
func readSecretsFile(path string) (map[string]string, error) {
	encryptedData, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%w %s: %w", errReadFile, path, err)
	}

	plainText, err := unprotect(encryptedData)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt secrets in %s: %w", path, err)
	}

	var decryptedSecrets map[string]string
	if err := json.Unmarshal(plainText, &decryptedSecrets); err != nil {
		return nil, fmt.Errorf("failed to parse secrets in %s: %w", path, err)
	}

	return decryptedSecrets, nil
}

// must hold lock
func readSecretsFromFile() (map[string]string, error) {
	loaded, err := readSecretsFile(filepath.Join(wavebase.GetWaveConfigDir(), SecretsFileName))
	if errors.Is(err, errReadFile) {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("secretstore: %v\n", err)
		}
		return make(map[string]string), nil
	}
	return loaded, err
}

// ReadSecretFile reads one secret straight from <configDir>/secrets.enc, bypassing the in-memory store and
// wavebase, for a process that must not start wavesrv's store (the claude apiKeyHelper). A missing file is
// not an error; any other failure is.
func ReadSecretFile(configDir, name string) (string, bool, error) {
	if name == WriteTsKey {
		return "", false, nil
	}
	fileSecrets, err := readSecretsFile(filepath.Join(configDir, SecretsFileName))
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	value, ok := fileSecrets[name]
	return value, ok, nil
}

// Flush writes the in-memory secrets to disk now instead of after the debounce. A no-op until the store
// has been used.
func Flush() error {
	lock.Lock()
	ready := initialized
	lock.Unlock()
	if !ready {
		return nil
	}
	return writeSecretsToFile()
}

func initSecretStore() error {
	lock.Lock()
	defer lock.Unlock()
	if initialized {
		return nil
	}

	now := time.Now()
	if !lastInitTryTime.IsZero() && now.Sub(lastInitTryTime) < InitRetryMs*time.Millisecond {
		return lastInitErr
	}

	lastInitTryTime = now
	loadedSecrets, err := readSecretsFromFile()
	if err != nil {
		lastInitErr = err
		return err
	}
	secrets = loadedSecrets

	writeRequestChan = make(chan struct{}, 1)
	initialized = true
	lastInitErr = nil
	go writerLoop()
	return nil
}

func writerLoop() {
	var timer *time.Timer
	for range writeRequestChan {
		if timer != nil {
			timer.Stop()
		}
		timer = time.AfterFunc(WriteDebounceMs*time.Millisecond, func() {
			if err := writeSecretsToFile(); err != nil {
				log.Printf("secretstore: error writing secrets: %v\n", err)
			}
		})
	}
}

func writeSecretsToFile() error {
	// a Flush and the debounce timer share one .tmp path
	writeMu.Lock()
	defer writeMu.Unlock()

	lock.Lock()
	secretsCopy := make(map[string]string, len(secrets)+1)
	for k, v := range secrets {
		secretsCopy[k] = v
	}
	secretsCopy[WriteTsKey] = time.Now().UTC().Format(time.RFC3339)
	lock.Unlock()

	jsonData, err := json.Marshal(secretsCopy)
	if err != nil {
		return fmt.Errorf("failed to marshal secrets: %w", err)
	}

	cipherText, err := protect(jsonData)
	if err != nil {
		return fmt.Errorf("failed to encrypt secrets: %w", err)
	}

	// write-then-rename: a torn write here would leave an undecryptable file, which loses every secret
	// rather than the one being changed
	secretsPath := filepath.Join(wavebase.GetWaveConfigDir(), SecretsFileName)
	tmpPath := secretsPath + ".tmp"
	if err := os.WriteFile(tmpPath, cipherText, 0600); err != nil {
		return fmt.Errorf("failed to write secrets file: %w", err)
	}
	if err := os.Rename(tmpPath, secretsPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to replace secrets file: %w", err)
	}

	return nil
}

func requestWrite() {
	select {
	case writeRequestChan <- struct{}{}:
	default:
	}
}

func SetSecret(name string, value string) error {
	if name == "" {
		return fmt.Errorf("secret name cannot be empty")
	}
	if !secretNameRegexp.MatchString(name) {
		return fmt.Errorf("secret name must start with a letter and contain only letters, numbers, and underscores")
	}
	if err := initSecretStore(); err != nil {
		return err
	}
	lock.Lock()
	defer lock.Unlock()

	secrets[name] = strings.TrimRight(value, "\r\n")
	requestWrite()
	return nil
}

func DeleteSecret(name string) error {
	if name == "" {
		return fmt.Errorf("secret name cannot be empty")
	}
	if err := initSecretStore(); err != nil {
		return err
	}
	lock.Lock()
	defer lock.Unlock()

	delete(secrets, name)
	requestWrite()
	return nil
}

func GetSecret(name string) (string, bool, error) {
	if name == WriteTsKey {
		return "", false, nil
	}
	if err := initSecretStore(); err != nil {
		return "", false, err
	}
	lock.Lock()
	defer lock.Unlock()

	value, exists := secrets[name]
	return value, exists, nil
}

func GetSecretNames() ([]string, error) {
	if err := initSecretStore(); err != nil {
		return nil, err
	}
	lock.Lock()
	defer lock.Unlock()

	names := make([]string, 0, len(secrets))
	for name := range secrets {
		if name == WriteTsKey {
			continue
		}
		names = append(names, name)
	}
	return names, nil
}
