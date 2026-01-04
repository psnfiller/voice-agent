package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"time"
)

var session = []byte(`
{
	"type": "realtime",
	"model": "gpt-realtime",
  "audio": {
	  "output": {
			"voice": "marin"
	  }
	},
	"instructions": "You are a helpful voice assistant. Only reply in english.  Keep replies concise. When the user asks to run, check, or retrieve anything from this machine, ALWAYS use the run_shell tool with an appropriate command. Do not simulate shell output; actually call the tool and return its result. Confirm potentially destructive actions before executing. Summarize results and ask clarifying questions when needed.",
  "tool_choice": "auto",
	"tools": [
    {
			"type": "function",
      "name": "run_shell",
			"description": "Execute a shell command on the server and return stdout/stderr. Use for tasks that require shell access.",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {
            "type": "array",
            "items": { "type": "string" },
            "description": "The command and its arguments as an array of strings, e.g., [\"ls\", \"-la\"]. Avoid interactive commands."
          }
        },
        "required": ["command"],
        "additionalProperties": false
      }
    }
  ]
}`)

func main() {
	fmt.Println("vim-go")
	openAIKey := os.Getenv("OPENAI_API_KEY")
	if openAIKey == "" {
		log.Fatal("no key")
	}
	if !json.Valid(session) {
		log.Fatal("no json")
	}

	logHandler := func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "POST" {
			io.WriteString(w, "Hello from a HandleFunc #2!\n")
			w.WriteHeader(500)
			return
		}
		data, err := io.ReadAll(req.Body)
		if err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}
		var cmdreq LogReq
		if err := json.Unmarshal(data, &cmdreq); err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}
		slog.Info("req", "msg", cmdreq)
		return
	}

	sessionHandler := func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "POST" {
			io.WriteString(w, "Hello from a HandleFunc #2!\n")
			w.WriteHeader(500)
			return
		}
		ctx := req.Context()

		sdp, err := io.ReadAll(req.Body)
		if err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}

		form := new(bytes.Buffer)
		writer := multipart.NewWriter(form)
		ff, err := writer.CreateFormField("sdp")
		if err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}
		ff.Write(sdp)
		ff, err = writer.CreateFormField("session")
		if err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}
		ff.Write(session)
		writer.Close()

		oaiReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/realtime/calls", form)
		if err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}
		slog.Info("request", "form data", form)
		oaiReq.Header["Authorization"] = []string{"Bearer " + openAIKey}
		oaiReq.Header.Set("Content-Type", writer.FormDataContentType())
		resp, err := http.DefaultClient.Do(oaiReq)
		if err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}
		if resp.StatusCode >= 300 {
			slog.Error("failed", "resp", resp)
			w.WriteHeader(500)
			return
		}
		sdpResp, err := io.ReadAll(resp.Body)
		if err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}

		slog.Info("response", "sdp", sdpResp)
		w.Write(sdpResp)
		return
	}
	toolsHandler := func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		ctx := req.Context()
		data, err := io.ReadAll(req.Body)
		if err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}
		var cmdreq CmdReq
		if err := json.Unmarshal(data, &cmdreq); err != nil {
			slog.Error("failed", "err", err)
			w.WriteHeader(500)
			return
		}

		if len(cmdreq.Command) == 0 {
			http.Error(w, "missing command", http.StatusBadRequest)
			return
		}
		slog.Info("tools request", "cmd", cmdreq)
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, cmdreq.Command[0], cmdreq.Command[1:]...)
		var stdoutBuf, stderrBuf bytes.Buffer
		cmd.Stdout = &stdoutBuf
		cmd.Stderr = &stderrBuf
		runErr := cmd.Run()
		exitCode := 0
		errStr := ""
		if runErr != nil {
			if exitErr, ok := runErr.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = -1
			}
			errStr = runErr.Error()
		}
		out := CmdResult{
			Stdout:   stdoutBuf.Bytes(),
			Stderr:   stderrBuf.Bytes(),
			OK:       runErr == nil,
			ExitCode: exitCode,
			Error:    errStr,
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(&out); err != nil {
			slog.Error("failed to write response", "err", err)
		}
		slog.Info("tools response", "ok", out.OK, "code", out.ExitCode, "stdout", string(out.Stdout), "stderr", string(out.Stderr), "err", out.Error)
	}

	http.HandleFunc("/session", sessionHandler)
	http.HandleFunc("/tools/shell", toolsHandler)
	http.HandleFunc("/log", logHandler)
	http.Handle("/", http.FileServer(http.Dir("public")))
	slog.Info("server starting", "addr", ":3000")
	log.Fatal(http.ListenAndServe(":3000", nil))

}

type LogReq struct {
	Msg string
	Req string
}
type CmdReq struct {
	Command []string
}
type CmdResult struct {
	Stdout []byte
	Stderr []byte
	OK     bool
	ExitCode int
	Error    string
}
