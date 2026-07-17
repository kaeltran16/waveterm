// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type SecretCommands interface {
	// secrets
	GetSecretsCommand(ctx context.Context, names []string) (map[string]string, error)
	GetSecretsNamesCommand(ctx context.Context) ([]string, error)
	SetSecretsCommand(ctx context.Context, secrets map[string]*string) error
	GetSecretsLinuxStorageBackendCommand(ctx context.Context) (string, error)
}
