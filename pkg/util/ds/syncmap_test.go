package ds

import (
	"testing"
)

func TestSyncMap_Set(t *testing.T) {
	sm := MakeSyncMap[int]()
	sm.Set("key1", 1)
	if sm.Get("key1") != 1 {
		t.Errorf("expected 1, got %d", sm.Get("key1"))
	}
}

func TestSyncMap_Get(t *testing.T) {
	sm := MakeSyncMap[int]()
	sm.Set("key1", 1)
	if sm.Get("key1") != 1 {
		t.Errorf("expected 1, got %d", sm.Get("key1"))
	}
	if sm.Get("key2") != 0 {
		t.Errorf("expected 0, got %d", sm.Get("key2"))
	}
}

func TestSyncMap_Delete(t *testing.T) {
	sm := MakeSyncMap[int]()
	sm.Set("key1", 1)
	sm.Delete("key1")
	if sm.Get("key1") != 0 {
		t.Errorf("expected 0, got %d", sm.Get("key1"))
	}
}
