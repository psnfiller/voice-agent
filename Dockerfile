FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/voice-agent server.go

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /app
COPY --from=build /out/voice-agent /app/voice-agent
COPY public ./public
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/voice-agent"]
