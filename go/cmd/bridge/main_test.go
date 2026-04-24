package main

import (
	"testing"
)

// ─── shortID ───────────────────────────────────────────────────────────────────

func TestShortID_Short(t *testing.T) {
	if got := shortID("k6-vu1"); got != "k6-vu1" {
		t.Errorf("shortID(%q) = %q, want %q", "k6-vu1", got, "k6-vu1")
	}
}

func TestShortID_Exactly8(t *testing.T) {
	if got := shortID("abcdefgh"); got != "abcdefgh" {
		t.Errorf("shortID(%q) = %q, want %q", "abcdefgh", got, "abcdefgh")
	}
}

func TestShortID_Truncates(t *testing.T) {
	if got := shortID("abcdefghi"); got != "abcdefgh" {
		t.Errorf("shortID(%q) = %q, want %q", "abcdefghi", got, "abcdefgh")
	}
}

func TestShortID_Empty(t *testing.T) {
	if got := shortID(""); got != "" {
		t.Errorf("shortID(%q) = %q, want empty", "", got)
	}
}

// ─── session registry ──────────────────────────────────────────────────────────

func resetSessions() {
	mu.Lock()
	sessions = make(map[string]*session, 512)
	mu.Unlock()
}

func TestGetOrCreate_SameID(t *testing.T) {
	resetSessions()
	s1 := getOrCreate("sess-a")
	s2 := getOrCreate("sess-a")
	if s1 != s2 {
		t.Error("getOrCreate: same id must return same session pointer")
	}
}

func TestGetOrCreate_DifferentID(t *testing.T) {
	resetSessions()
	s1 := getOrCreate("sess-x")
	s2 := getOrCreate("sess-y")
	if s1 == s2 {
		t.Error("getOrCreate: different ids must return different sessions")
	}
}

func TestGetOrCreate_ChannelsInitialised(t *testing.T) {
	resetSessions()
	s := getOrCreate("sess-init")
	if s.ch == nil {
		t.Error("expected buffered packet channel to be non-nil")
	}
	if cap(s.ch) == 0 {
		t.Error("expected packet channel to be buffered (cap > 0)")
	}
	if s.ready == nil {
		t.Error("expected ready channel to be non-nil")
	}
}

func TestMarkReady_ClosesChannel(t *testing.T) {
	resetSessions()
	s := getOrCreate("mark-ready")
	markReady(s)
	select {
	case <-s.ready:
		// expected — channel is closed
	default:
		t.Error("ready channel not closed after markReady")
	}
}

func TestMarkReady_Idempotent(t *testing.T) {
	resetSessions()
	s := getOrCreate("mark-ready-idem")
	markReady(s)
	// Second call must not panic (close on closed channel would panic).
	markReady(s)
}

func TestRemove_DeletesSession(t *testing.T) {
	resetSessions()
	getOrCreate("to-del")
	remove("to-del")
	mu.Lock()
	_, exists := sessions["to-del"]
	mu.Unlock()
	if exists {
		t.Error("expected session to be deleted by remove()")
	}
}

func TestRemove_NonExistentIsNoop(t *testing.T) {
	resetSessions()
	// Must not panic when removing a session that was never created.
	remove("never-existed")
}
