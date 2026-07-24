// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisembed is the opt-in, BYOK embedding foundation for Jarvis v2:
// a provider seam, a sqlite-vec derived-layer index with hybrid reconciliation,
// section-level chunking, and a graceful-degradation contract. It has no
// consumer in S1; S2 (semantic recall/attribution) is the first.
package jarvisembed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const secretKeyName = "jarvis:embedapikey"

// resolveConfig reads the BYOK settings. enabled is false unless the flag is on
// and both base URL and model are set.
func resolveConfig() (baseURL, model string, enabled bool) {
	s := wconfig.GetWatcher().GetFullConfig().Settings
	baseURL, model = s.JarvisEmbedBaseURL, s.JarvisEmbedModel
	enabled = s.JarvisEmbedEnabled && baseURL != "" && model != ""
	return
}

func resolveKey() (string, bool) {
	v, ok, err := secretstore.GetSecret(secretKeyName)
	if err != nil || !ok || v == "" {
		return "", false
	}
	return v, true
}

// Available reports whether embeddings are fully configured (flag on, base URL +
// model set, key present). Callers degrade gracefully when false.
func Available() bool {
	_, _, enabled := resolveConfig()
	if !enabled {
		return false
	}
	_, ok := resolveKey()
	return ok
}

// Embedder turns text into vectors. One OpenAI-compatible HTTP implementation
// ships in S1; SetEmbedderForTest injects a deterministic mock in tests.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Model() string
}

type openAICompatEmbedder struct {
	baseURL, model, key string
	hc                  *http.Client
}

func (e *openAICompatEmbedder) Model() string { return e.model }

func (e *openAICompatEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	reqBody, _ := json.Marshal(map[string]any{"model": e.model, "input": texts})
	url := strings.TrimRight(e.baseURL, "/") + "/embeddings"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.key)
	resp, err := e.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jarvisembed: embed request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jarvisembed: embed status %d", resp.StatusCode)
	}
	var parsed struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("jarvisembed: decode embed response: %w", err)
	}
	out := make([][]float32, len(parsed.Data))
	for i, d := range parsed.Data {
		out[i] = d.Embedding
	}
	if len(out) != len(texts) {
		return nil, fmt.Errorf("jarvisembed: embedded %d of %d inputs", len(out), len(texts))
	}
	return out, nil
}

func newConfiguredEmbedder() (Embedder, bool) {
	baseURL, model, enabled := resolveConfig()
	if !enabled {
		return nil, false
	}
	key, ok := resolveKey()
	if !ok {
		return nil, false
	}
	return &openAICompatEmbedder{baseURL: baseURL, model: model, key: key, hc: &http.Client{Timeout: 60 * time.Second}}, true
}

var (
	testEmbedderMu sync.Mutex
	testEmbedder   Embedder
)

// SetEmbedderForTest injects a mock embedder used by OpenIndex when set (mirrors
// C's SetSynthesizeForTest). Returns a restore func.
func SetEmbedderForTest(e Embedder) (restore func()) {
	testEmbedderMu.Lock()
	prev := testEmbedder
	testEmbedder = e
	testEmbedderMu.Unlock()
	return func() {
		testEmbedderMu.Lock()
		testEmbedder = prev
		testEmbedderMu.Unlock()
	}
}

func embedderForTest() Embedder {
	testEmbedderMu.Lock()
	defer testEmbedderMu.Unlock()
	return testEmbedder
}
