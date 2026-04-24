# ── Stage 1: Generate proto stubs ─────────────────────────────────────────────
# Build context: . (streamhub-demo/ repo root)
# docker build -t streamhub .
# docker build -t streamhub -f Dockerfile .
FROM golang:1.22-alpine AS proto

RUN apk add --no-cache protobuf

# Install protoc plugins at pinned versions for reproducibility.
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.34.2 && \
    go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.4.0

WORKDIR /src
COPY proto/audio_forward.proto audio_forward.proto
COPY go/ ./go/

RUN mkdir -p go/pb && \
    PATH="$PATH:$(go env GOPATH)/bin" protoc \
      --go_out=go/pb      --go_opt=paths=source_relative \
      --go-grpc_out=go/pb --go-grpc_opt=paths=source_relative \
      -I /src \
      /src/audio_forward.proto

# ── Stage 2: Build StreamHub binary ───────────────────────────────────────────
FROM golang:1.22-alpine AS builder

WORKDIR /build

# Copy module files first for layer caching.
COPY go/go.mod go/go.mod
# go.sum may not exist on a fresh clone — tidy will (re)create it.
COPY go/ ./
COPY --from=proto /src/go/pb/ ./pb/

RUN go mod tidy && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o streamhub ./cmd/streamhub

# ── Stage 3: Minimal runtime image ────────────────────────────────────────────
# distroless/static has no shell but includes CA certs and timezone data.
FROM gcr.io/distroless/static-debian12

COPY --from=builder /build/streamhub /streamhub

# StreamHub WebSocket port (k6 sender connects here).
EXPOSE 8765

ENTRYPOINT ["/streamhub"]
# Default flags — override at `docker run` time:
#   docker run smarthub --ws-port=8765 --bridge-addr=host.docker.internal:50052
