// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package secretstore

import (
	"encoding/json"
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
var secrets = make(map[string]string)
var writeRequestChan chan struct{}
var initialized bool
var lastInitTryTime time.Time
var lastInitErr error
var secretNameRegexp = regexp.MustCompile(SecretNamePattern)

// must hold lock
func readSecretsFromFile() (map[string]string, error) {
	secretsPath := filepath.Join(wavebase.GetWaveConfigDir(), SecretsFileName)

	encryptedData, err := os.ReadFile(secretsPath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("secretstore: could not read secrets file: %v\n", err)
		}
		return make(map[string]string), nil
	}

	plainText, err := unprotect(encryptedData)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt secrets: %w", err)
	}

	var decryptedSecrets map[string]string
	if err := json.Unmarshal(plainText, &decryptedSecrets); err != nil {
		return nil, fmt.Errorf("failed to parse secrets: %w", err)
	}

	return decryptedSecrets, nil
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

func CountSecrets() (int, error) {
	lock.Lock()
	defer lock.Unlock()
	
	if !initialized {
		return 0, fmt.Errorf("secret store not initialized")
	}

	count := 0
	for name := range secrets {
		if name == WriteTsKey {
			continue
		}
		count++
	}
	return count, nil
}

// GetLinuxStorageBackend reported which OS keyring the Electron shell's safeStorage had selected
// (gnome-libsecret, kwallet, basic_text). Under Tauri there is no shell-side keyring to ask — at-rest
// encryption is now in-process, per platform — so there is no backend to name and this reports empty.
// It is kept rather than deleted because it backs a generated wshrpc command; retiring that is a
// codegen change tracked in the backend-legacy-cleanup plan.
func GetLinuxStorageBackend() (string, error) {
	return "", nil
}
