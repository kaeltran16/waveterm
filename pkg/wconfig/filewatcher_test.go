// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"errors"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

const dispatcherTestTimeout = 2 * time.Second

func receiveConfigVersion(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case version := <-ch:
		return version
	case <-time.After(dispatcherTestTimeout):
		t.Fatal("timed out waiting for config dispatch")
		return ""
	}
}

func TestConfigDispatcherPreservesUpdateOrder(t *testing.T) {
	dispatcher := newConfigDispatcher()
	dispatcher.start()
	t.Cleanup(dispatcher.close)
	watcher := &Watcher{dispatcher: dispatcher}

	entered := make(chan struct{})
	release := make(chan struct{})
	observed := make(chan string, 2)
	watcher.RegisterUpdateHandler(func(config FullConfigType) {
		if config.Version == "A" {
			close(entered)
			<-release
		}
		observed <- config.Version
	})

	watcher.notifyHandlers(FullConfigType{Version: "A"})
	<-entered
	watcher.notifyHandlers(FullConfigType{Version: "B"})
	close(release)
	if got := receiveConfigVersion(t, observed); got != "A" {
		t.Fatalf("first update = %q, want A", got)
	}
	if got := receiveConfigVersion(t, observed); got != "B" {
		t.Fatalf("second update = %q, want B", got)
	}
}

func TestConfigDispatcherContinuesAfterHandlerPanic(t *testing.T) {
	dispatcher := newConfigDispatcher()
	dispatcher.start()
	t.Cleanup(dispatcher.close)
	watcher := &Watcher{dispatcher: dispatcher}

	observed := make(chan string, 2)
	watcher.RegisterUpdateHandler(func(FullConfigType) { panic("test panic") })
	watcher.RegisterUpdateHandler(func(config FullConfigType) { observed <- config.Version })

	watcher.notifyHandlers(FullConfigType{Version: "A"})
	watcher.notifyHandlers(FullConfigType{Version: "B"})

	if got := receiveConfigVersion(t, observed); got != "A" {
		t.Fatalf("first update = %q, want A", got)
	}
	if got := receiveConfigVersion(t, observed); got != "B" {
		t.Fatalf("second update = %q, want B", got)
	}
}

func TestConfigDispatcherCloseDropsQueuedUpdates(t *testing.T) {
	dispatcher := newConfigDispatcher()
	dispatcher.start()

	entered := make(chan struct{})
	release := make(chan struct{})
	observed := make(chan string, 2)
	handler := func(config FullConfigType) {
		if config.Version == "A" {
			close(entered)
			<-release
		}
		observed <- config.Version
	}

	dispatcher.enqueue(configDispatch{config: FullConfigType{Version: "A"}, handlers: []ConfigUpdateHandler{handler}})
	<-entered
	dispatcher.enqueue(configDispatch{config: FullConfigType{Version: "B"}, handlers: []ConfigUpdateHandler{handler}})
	dispatcher.close()
	if dispatcher.enqueue(configDispatch{config: FullConfigType{Version: "C"}, handlers: []ConfigUpdateHandler{handler}}) {
		t.Fatal("enqueue after close must fail")
	}
	close(release)

	select {
	case <-dispatcher.done:
	case <-time.After(dispatcherTestTimeout):
		t.Fatal("dispatcher did not stop")
	}
	if got := receiveConfigVersion(t, observed); got != "A" {
		t.Fatalf("completed update = %q, want A", got)
	}
	select {
	case got := <-observed:
		t.Fatalf("queued update %q ran after close", got)
	default:
	}
}

func TestNewWatcherReturnsConstructionError(t *testing.T) {
	sentinel := errors.New("watcher unavailable")
	watcher, err := newWatcher(func() (*fsnotify.Watcher, error) {
		return nil, sentinel
	})
	if watcher != nil {
		t.Fatal("failed construction must not return a watcher")
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want sentinel", err)
	}
}
