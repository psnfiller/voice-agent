import express from "express";
import { exec as execCb, spawn } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execCb);

// Language preference (e.g., en-US, es-ES). If set, the agent will respond only in this language.
const LANG = "en-US";

const BASE_INSTRUCTIONS = process.env.VOICE_AGENT_PROMPT || "You are a helpful voice assistant. Keep replies concise. When the user asks to run, check, or retrieve anything from this machine, ALWAYS use the run_shell tool with an appropriate command. Do not simulate shell output; actually call the tool and return its result. Confirm potentially destructive actions before executing. Summarize results and ask clarifying questions when needed.";
const INSTRUCTIONS = LANG ? `${BASE_INSTRUCTIONS} Always respond only in ${LANG}. If the user speaks another language, politely explain you can only respond in ${LANG} unless they request a switch.` : BASE_INSTRUCTIONS;

const log = (...args) => console.error("[voice-agent]", ...args);
log("starting with env VOICE_AGENT_PROMPT set:", typeof process.env.VOICE_AGENT_PROMPT === "string");
log("language preference:", LANG || "<auto>");
log("instructions length:", INSTRUCTIONS.length);
log("instructions preview:", INSTRUCTIONS.slice(0, 160) + (INSTRUCTIONS.length > 160 ? "…" : ""));

const app = express();

app.use('/', express.static('public'))
app.use(express.static('public'))

// request logging to stderr
app.use((req, _res, next) => {
  log(`${req.method} ${req.url} from ${req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress}`);
  next();
});

// Parse raw SDP payloads posted from the browser
app.use(express.text({ type: ["application/sdp", "text/plain"] }));
// JSON parsing for tool calls routed through our server
app.use(express.json());

// Configure the Realtime API session, including a tool for running shell commands.
const sessionConfigObj = {
  type: "realtime",
  model: "gpt-realtime",
  audio: { output: { voice: "marin" } },
  instructions: INSTRUCTIONS,
  tool_choice: "auto",
  tools: [
    {
      type: "function",
      name: "run_shell",
      description:
        "Execute a shell command on the server and return stdout/stderr. Use for tasks that require shell access.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The exact shell command to execute. Avoid interactive commands.",
          },
          cwd: {
            type: "string",
            description: "Optional working directory for the command.",
          },
          timeout_ms: {
            type: "number",
            description: "Optional timeout in milliseconds (default 10000).",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ],
};
const sessionConfig = JSON.stringify(sessionConfigObj);
log("sessionConfig prepared (bytes):", sessionConfig.length);

// An endpoint which creates a Realtime API session.
app.post("/session", async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

    log("/session called from", ip)
    log("/session instructions (len)", INSTRUCTIONS.length);
    const fd = new FormData();
    fd.set("sdp", req.body);
    fd.set("session", sessionConfig);

    try {
        log("POST https://api.openai.com/v1/realtime/calls");
        const r = await fetch("https://api.openai.com/v1/realtime/calls", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: fd,
        });
        // Send back the SDP we received from the OpenAI REST API
        const sdp = await r.text();
        if (!r.ok) {
          log("non-OK response status:", r.status, r.statusText);
          log("non-OK response body (first 400 bytes):", sdp.slice(0, 400));
        }
        res.send(sdp);

    } catch (error) {
        console.error("[voice-agent] Token generation error:", error);
        res.status(500).json({ error: "Failed to generate token" });
    }
});

// Local tool endpoint: execute a shell command on the server.
// This is invoked by the browser when the model issues a run_shell tool call.
app.post("/tools/shell", async (req, res) => {
  try {
    const { command, cwd, timeout_ms } = req.body || {};
    log("/tools/shell/stream", { command, cwd, timeout_ms });
    log("/tools/shell", { command, cwd, timeout_ms });
    if (!command || typeof command !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'command'" });
    }
    // Basic safeguard against extremely long commands
    if (command.length > 2000) {
      return res.status(400).json({ error: "Command too long" });
    }

    const options = {
      timeout: typeof timeout_ms === "number" ? timeout_ms : 10_000,
      maxBuffer: 1024 * 1024, // 1 MB stdout/stderr each
      shell: "/bin/bash",
    };
    if (cwd && typeof cwd === "string") options.cwd = cwd;

    try {
      const started = Date.now();
      const { stdout, stderr } = await exec(command, options);
      log("/tools/shell done in", Date.now() - started, "ms");
      res.json({ ok: true, stdout, stderr });
    } catch (err) {
      // exec throws on non-zero exit or timeout
      res.json({
        ok: false,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(err.message ?? err),
        code: typeof err.code === "number" ? err.code : undefined,
        signal: err.signal ?? undefined,
      });
    }
  } catch (error) {
    console.error("[voice-agent] /tools/shell error:", error);
    res.status(500).json({ error: "Failed to execute command" });
  }
});

// Streaming variant: streams stdout/stderr to the client as the command runs.
app.post("/tools/shell/stream", async (req, res) => {
  try {
    const { command, cwd, timeout_ms } = req.body || {};
    log("/tools/shell/stream", { command, cwd, timeout_ms });
    log("/tools/shell", { command, cwd, timeout_ms });
    if (!command || typeof command !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'command'" });
    }
    if (command.length > 2000) {
      return res.status(400).json({ error: "Command too long" });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // For proxies like nginx to avoid buffering (best-effort)
    res.setHeader("X-Accel-Buffering", "no");

    const sh = spawn("/bin/bash", ["-lc", command], {
      cwd: typeof cwd === "string" ? cwd : undefined,
      env: process.env,
    });

    let killed = false;
    let timer = setTimeout(() => {
      if (!sh.killed) {
        killed = true;
        sh.kill("SIGTERM");
        // Hard kill after grace period
        setTimeout(() => !sh.killed && sh.kill("SIGKILL"), 2000);
        log("/tools/shell/stream timeout, sent SIGTERM");
        res.write(`
[timeout after ${typeof timeout_ms === "number" ? timeout_ms : 10000} ms]
`);
      }
    }, typeof timeout_ms === "number" ? timeout_ms : 10000);

    sh.stdout.on("data", (chunk) => {
      res.write(chunk);
    });
    sh.stderr.on("data", (chunk) => {
      res.write(chunk);
    });
    sh.on("error", (err) => {
      log("/tools/shell/stream child error:", String(err?.message || err));
      try { res.write(`ERROR: ${String(err.message || err)}
`); } catch {}
    });
    sh.on("close", (code, signal) => {
      log("/tools/shell/stream close", { code, signal, killed });
      clearTimeout(timer);
      const trailer = `
[exit ${code !== null ? code : ""}${signal ? ` signal ${signal}` : ""}${killed ? " (killed)" : ""}]
`;
      try { res.write(trailer); } catch {}
      res.end();
    });
  } catch (error) {
    console.error("[voice-agent] /tools/shell/stream error:", error);
    // If headers not sent, send JSON; else just end
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to execute command" });
    } else {
      try { res.end(); } catch {}
    }
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`listening on ${PORT}`);
  log(`instructions active (len ${INSTRUCTIONS.length}) preview:`, INSTRUCTIONS.slice(0, 200) + (INSTRUCTIONS.length > 200 ? "…" : ""));
});
