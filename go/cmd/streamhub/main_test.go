package main

import (
	"encoding/json"
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

// ─── metadata JSON parsing ─────────────────────────────────────────────────────

func TestMetadataJSON_Valid(t *testing.T) {
	raw := `{"session_id":"k6-vu1","sample_rate":16000,"channels":1,"chunk_ms":20}`
	var m metadata
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	if m.SessionID != "k6-vu1" {
		t.Errorf("SessionID = %q, want %q", m.SessionID, "k6-vu1")
	}
	if m.SampleRate != 16000 {
		t.Errorf("SampleRate = %d, want 16000", m.SampleRate)
	}
	if m.Channels != 1 {
		t.Errorf("Channels = %d, want 1", m.Channels)
	}
	if m.ChunkMS != 20 {
		t.Errorf("ChunkMS = %d, want 20", m.ChunkMS)
	}
}

func TestMetadataJSON_MissingFields(t *testing.T) {
	raw := `{"session_id":"test-session"}`
	var m metadata
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	// Zero values for missing numeric fields are valid.
	if m.SessionID != "test-session" {
		t.Errorf("SessionID = %q, want %q", m.SessionID, "test-session")
	}
	if m.SampleRate != 0 {
		t.Errorf("SampleRate = %d, want 0 (missing)", m.SampleRate)
	}
}

func TestMetadataJSON_EmptySessionID(t *testing.T) {
	raw := `{"session_id":"","sample_rate":16000,"channels":1,"chunk_ms":20}`
	var m metadata
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	if m.SessionID != "" {
		t.Errorf("expected empty SessionID, got %q", m.SessionID)
	}
}

func TestMetadataJSON_Invalid(t *testing.T) {
	raw := `not-json`
	var m metadata
	if err := json.Unmarshal([]byte(raw), &m); err == nil {
		t.Error("expected Unmarshal to fail on invalid JSON")
	}
}
