# Voice agent

A trivial voice agent server. Runs shell commands in a docker container.

This uses [OpenAI's realtime conversations
API](https://platform.openai.com/docs/guides/realtime-conversations).

To run

```
OPENAI_API_KEY=$(op item get openai-key --reveal --fields credential) docker compose up --build
```

### logs

when adding logs in javascript, use the `log()` call.  to see logs

```
docker logs voice-agent-voice-agent-1
```

## the container

Commands are run in a container.  You can use `shell_client.go` to run commands
yourself.

Precautions:

* Non root
* no capabilities
* read only filesystem
* no local network or tailscale access (internet access is generally needed)
* openai key not in env
* limit cpu and memory

## TODO(psn):

* transscript  - include human
