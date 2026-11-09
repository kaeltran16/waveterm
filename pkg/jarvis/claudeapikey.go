// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"errors"
)

const (
	// ClaudeApiKeySecretName must not start with claudeAccountSecretPrefix, or ListClaudeAccounts would
	// read the key as an account.
	ClaudeApiKeySecretName = "claudeapikey"
	// ClaudeApiKeyHelperCmd is the wsh subcommand Claude Code's apiKeyHelper runs to read the key.
	ClaudeApiKeyHelperCmd = "claude-api-key"
)

var errClaudeApiKeyUnimplemented = errors.New("claude api key: not implemented")

func SaveClaudeApiKey(ctx context.Context, key string) error { return errClaudeApiKeyUnimplemented }

func SwitchToClaudeApiKey() error { return errClaudeApiKeyUnimplemented }

func RemoveClaudeApiKey() error { return errClaudeApiKeyUnimplemented }
