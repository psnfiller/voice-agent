# Voice agent

A trivial voice agent server. Runs shell commands in a docker container.

To run

```
OPENAI_API_KEY=$(op item get openai-key --reveal --fields credential) docker compose up --build
```

## TODO(psn):

* transscript
* ready incicator
