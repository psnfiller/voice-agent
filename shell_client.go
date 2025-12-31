package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
)

// Match server types
type CmdReq struct {
	Command []string
}

type CmdResult struct {
	Stdout []byte
	Stderr []byte
	OK     bool
}

func main() {
	url := flag.String("url", "http://localhost:8080/tools", "tools endpoint URL")
	quiet := flag.Bool("q", false, "suppress labels; print only command output to respective streams")
	flag.Parse()

	args := flag.Args()
	if len(args) == 0 {
		fmt.Fprintf(os.Stderr, "usage: shell_client [flags] -- <command> [args...]\n")
		flag.PrintDefaults()
		os.Exit(2)
	}

	req := CmdReq{Command: args}
	body, err := json.Marshal(&req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal request: %v\n", err)
		os.Exit(1)
	}

	httpResp, err := http.Post(*url, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "post: %v\n", err)
		os.Exit(1)
	}
	defer httpResp.Body.Close()

	if httpResp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(httpResp.Body)
		fmt.Fprintf(os.Stderr, "server returned %s: %s\n", httpResp.Status, string(b))
		os.Exit(1)
	}

	respBody, err := io.ReadAll(httpResp.Body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read response: %v\n", err)
		os.Exit(1)
	}

	var res CmdResult
	if err := json.Unmarshal(respBody, &res); err != nil {
		fmt.Fprintf(os.Stderr, "unmarshal response: %v\nraw: %s\n", err, string(respBody))
		os.Exit(1)
	}

	if *quiet {
		if len(res.Stdout) > 0 {
			os.Stdout.Write(res.Stdout)
		}
		if len(res.Stderr) > 0 {
			os.Stderr.Write(res.Stderr)
		}
	} else {
		if len(res.Stdout) > 0 {
			fmt.Fprint(os.Stdout, string(res.Stdout))
		}
		if len(res.Stderr) > 0 {
			fmt.Fprint(os.Stderr, string(res.Stderr))
		}
	}

	if !res.OK {
		os.Exit(1)
	}
}

