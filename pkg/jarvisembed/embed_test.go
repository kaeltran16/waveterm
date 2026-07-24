// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSecretKeyNameStable(t *testing.T) {
	if secretKeyName != "jarvis:embedapikey" {
		t.Fatalf("secretKeyName = %q, want jarvis:embedapikey", secretKeyName)
	}
}

func TestOpenAICompatEmbed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("auth header = %q", got)
		}
		var body struct {
			Model string   `json:"model"`
			Input []string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "test-model" {
			t.Errorf("model = %q", body.Model)
		}
		resp := map[string]any{"data": []map[string]any{}}
		for range body.Input {
			resp["data"] = append(resp["data"].([]map[string]any), map[string]any{"embedding": []float32{0.1, 0.2, 0.3}})
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	e := &openAICompatEmbedder{baseURL: srv.URL, model: "test-model", key: "test-key", hc: http.DefaultClient}
	vecs, err := e.Embed(context.Background(), []string{"a", "b"})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	if len(vecs) != 2 || len(vecs[0]) != 3 || vecs[0][0] != 0.1 {
		t.Fatalf("unexpected vectors: %v", vecs)
	}
	if e.Model() != "test-model" {
		t.Fatalf("Model() = %q", e.Model())
	}
}
