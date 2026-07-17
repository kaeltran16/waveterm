// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/secretstore"
)

func (ws *WshServer) GetSecretsCommand(ctx context.Context, names []string) (map[string]string, error) {
	result := make(map[string]string)
	for _, name := range names {
		value, exists, err := secretstore.GetSecret(name)
		if err != nil {
			return nil, fmt.Errorf("error getting secret %q: %w", name, err)
		}
		if exists {
			result[name] = value
		}
	}
	return result, nil
}

func (ws *WshServer) GetSecretsNamesCommand(ctx context.Context) ([]string, error) {
	names, err := secretstore.GetSecretNames()
	if err != nil {
		return nil, fmt.Errorf("error getting secret names: %w", err)
	}
	return names, nil
}

func (ws *WshServer) SetSecretsCommand(ctx context.Context, secrets map[string]*string) error {
	for name, value := range secrets {
		if value == nil {
			err := secretstore.DeleteSecret(name)
			if err != nil {
				return fmt.Errorf("error deleting secret %q: %w", name, err)
			}
		} else {
			err := secretstore.SetSecret(name, *value)
			if err != nil {
				return fmt.Errorf("error setting secret %q: %w", name, err)
			}
		}
	}
	return nil
}

func (ws *WshServer) GetSecretsLinuxStorageBackendCommand(ctx context.Context) (string, error) {
	backend, err := secretstore.GetLinuxStorageBackend()
	if err != nil {
		return "", fmt.Errorf("error getting linux storage backend: %w", err)
	}
	return backend, nil
}
