#!/usr/bin/env bash
# generate_proto.sh — Compile audio_forward.proto → Go stubs
#
# Run from: go/
#   bash generate_proto.sh
#
# Requires: protoc   (brew install protobuf)
# Plugins are installed automatically via `go install` if missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO_FILE="$SCRIPT_DIR/../proto/audio_forward.proto"
OUT_DIR="$SCRIPT_DIR/pb"

mkdir -p "$OUT_DIR"

# ─── Install protoc plugins if not already on PATH ────────────────────────────
install_if_missing() {
  local cmd="$1" pkg="$2"
  if ! command -v "$cmd" &>/dev/null; then
    echo "Installing $cmd..."
    go install "$pkg@latest"
  fi
}

install_if_missing protoc-gen-go       google.golang.org/protobuf/cmd/protoc-gen-go
install_if_missing protoc-gen-go-grpc  google.golang.org/grpc/cmd/protoc-gen-go-grpc

# Add GOPATH/bin to PATH so protoc can find the plugins.
export PATH="$PATH:$(go env GOPATH)/bin"

# ─── Generate ─────────────────────────────────────────────────────────────────
protoc \
  --go_out="$OUT_DIR"      --go_opt=paths=source_relative \
  --go-grpc_out="$OUT_DIR" --go-grpc_opt=paths=source_relative \
  -I "$(dirname "$PROTO_FILE")" \
  "$PROTO_FILE"

echo "Generated Go stubs in $OUT_DIR/"
ls -lh "$OUT_DIR"/*.pb.go

# ─── Next steps ───────────────────────────────────────────────────────────────
# Run from go/:
#   go mod tidy
#
# Start StreamHub (WS server, gRPC client):
#   go run ./cmd/streamhub
#   go run ./cmd/streamhub --ws-port=8765 --bridge-addr=127.0.0.1:50052
#
# Start Bridge (pure gRPC server):
#   go run ./cmd/bridge
#   go run ./cmd/bridge --port=50052
