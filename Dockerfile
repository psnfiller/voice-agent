FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/voice-agent server.go

FROM debian:bookworm-slim AS runtime

# Install common tools and certs, then clean up apt caches to keep the image smaller
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        wget \
        jq \
        iproute2 \
        iputils-ping \
        dnsutils \
        traceroute \
        netcat-openbsd \
        procps \
        vim-tiny \
        less; \
    rm -rf /var/lib/apt/lists/*; \
    update-ca-certificates

WORKDIR /app
COPY --from=build /out/voice-agent /usr/local/bin/voice-agent
COPY public ./public

# Server listens on 3000
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/voice-agent"]
