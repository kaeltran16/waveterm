// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

type fsnotifyFactory func() (*fsnotify.Watcher, error)

var watcherOnce = sync.OnceValues(func() (*Watcher, error) {
	return newWatcher(fsnotify.NewWatcher)
})

type Watcher struct {
	initialized bool
	watcher     *fsnotify.Watcher
	mutex       sync.Mutex
	fullConfig  FullConfigType
}

type WatcherUpdate struct {
	FullConfig FullConfigType `json:"fullconfig"`
}

func newWatcher(factory fsnotifyFactory) (*Watcher, error) {
	fileWatcher, err := factory()
	if err != nil {
		return nil, err
	}
	watcher := &Watcher{
		watcher: fileWatcher,
	}
	configDirAbsPath := wavebase.GetWaveConfigDir()
	log.Printf("create config watcher, configdir=%q", configDirAbsPath)
	const failedStr = "failed to add path %s to watcher: %v"
	if err := watcher.watcher.Add(configDirAbsPath); err != nil {
		log.Printf(failedStr, configDirAbsPath, err)
	}
	for _, dir := range GetConfigSubdirs() {
		if err := watcher.watcher.Add(dir); err != nil && !os.IsNotExist(err) {
			log.Printf(failedStr, dir, err)
		}
	}
	return watcher, nil
}

func InitWatcher() (*Watcher, error) {
	return watcherOnce()
}

// GetWatcher returns the singleton instance of the Watcher.
func GetWatcher() *Watcher {
	watcher, err := InitWatcher()
	if err != nil {
		panic(fmt.Errorf("initializing config watcher: %w", err))
	}
	return watcher
}

func (w *Watcher) Start() {
	w.mutex.Lock()
	if w.initialized || w.watcher == nil {
		w.mutex.Unlock()
		return
	}
	w.initialized = true
	fileWatcher := w.watcher
	w.mutex.Unlock()

	log.Printf("starting file watcher\n")
	w.sendInitialValues()

	go func() {
		defer func() {
			panichandler.PanicHandler("filewatcher:Start", recover())
		}()
		for {
			select {
			case event, ok := <-fileWatcher.Events:
				if !ok {
					return
				}
				w.handleEvent(event)
			case err, ok := <-fileWatcher.Errors:
				if !ok {
					return
				}
				log.Println("watcher error:", err)
			}
		}
	}()
}

// for initial values, exit on first error
func (w *Watcher) sendInitialValues() error {
	fullConfig := ReadFullConfig()
	w.mutex.Lock()
	w.fullConfig = fullConfig
	w.mutex.Unlock()
	w.broadcast(WatcherUpdate{FullConfig: fullConfig})
	return nil
}

func (w *Watcher) Close() {
	w.mutex.Lock()
	fileWatcher := w.watcher
	w.watcher = nil
	w.mutex.Unlock()
	if fileWatcher != nil {
		fileWatcher.Close()
		log.Println("file watcher closed")
	}
}

func (w *Watcher) broadcast(message WatcherUpdate) {
	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_Config,
		Data:  message,
	})
}

func (w *Watcher) GetFullConfig() FullConfigType {
	w.mutex.Lock()
	defer w.mutex.Unlock()
	return w.fullConfig
}

func (w *Watcher) handleEvent(event fsnotify.Event) {
	fileName := filepath.ToSlash(event.Name)
	if event.Op == fsnotify.Chmod {
		return
	}
	if !isValidSubSettingsFileName(fileName) {
		return
	}
	w.handleSettingsFileEvent(event, fileName)
}

var validFileRe = regexp.MustCompile(`^[a-zA-Z0-9_@.-]+\.json$`)

func isValidSubSettingsFileName(fileName string) bool {
	if filepath.Ext(fileName) != ".json" {
		return false
	}
	baseName := filepath.Base(fileName)
	return validFileRe.MatchString(baseName)
}

func (w *Watcher) handleSettingsFileEvent(_ fsnotify.Event, _ string) {
	fullConfig := ReadFullConfig()
	w.mutex.Lock()
	w.fullConfig = fullConfig
	w.mutex.Unlock()
	w.broadcast(WatcherUpdate{FullConfig: fullConfig})
}
