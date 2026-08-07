// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package consult

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/launchdarkly/eventsource"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/openaichat"
	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	openRouterChatEndpoint = "https://openrouter.ai/api/v1/chat/completions"
	openRouterSecretName   = "OPENROUTER_KEY"
	openRouterTimeout      = 5 * time.Minute
)

type openrouterBackend struct{}

func (b *openrouterBackend) Run(ctx context.Context, spec RuntimeSpec, prompt string, emit func(string)) (string, error) {
	key, exists, err := secretstore.GetSecret(openRouterSecretName)
	if err != nil {
		return "", fmt.Errorf("reading OPENROUTER_KEY: %w", err)
	}
	if !exists || key == "" {
		return "", fmt.Errorf("OpenRouter API key not configured (set OPENROUTER_KEY)")
	}

	model := spec.Model
	if model == "" {
		model = OpenrouterMidModel()
	}

	body := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"stream": true,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshaling request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, openRouterChatEndpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)

	client := &http.Client{Timeout: openRouterTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("OpenRouter request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("OpenRouter API error %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}

	decoder := eventsource.NewDecoder(resp.Body)
	var full strings.Builder
	for {
		ev, derr := decoder.Decode()
		if derr != nil {
			if derr == io.EOF {
				break
			}
			return full.String(), fmt.Errorf("SSE decode error: %w", derr)
		}
		data := strings.TrimSpace(ev.Data())
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk openaichat.StreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Content != "" {
				full.WriteString(choice.Delta.Content)
				emit(choice.Delta.Content)
			}
		}
	}
	return full.String(), nil
}

// OpenrouterCheapModel returns the configured cheap model or the default.
func OpenrouterCheapModel() string {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.HeadlessOpenRouterCheapModel != "" {
		return cfg.Settings.HeadlessOpenRouterCheapModel
	}
	return "deepseek/deepseek-v4-flash"
}

// OpenrouterMidModel returns the configured mid model or the default.
func OpenrouterMidModel() string {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.HeadlessOpenRouterMidModel != "" {
		return cfg.Settings.HeadlessOpenRouterMidModel
	}
	return "deepseek/deepseek-v4-pro"
}

// OpenrouterLongModel returns the configured long-context model or the default.
func OpenrouterLongModel() string {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.HeadlessOpenRouterLongModel != "" {
		return cfg.Settings.HeadlessOpenRouterLongModel
	}
	return "deepseek/deepseek-v4-pro"
}
