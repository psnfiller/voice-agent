async function main() {
  // Store a reference to the <h1> in a variable
  const myHeading = document.querySelector("h1");
  if (myHeading) myHeading.textContent = "Hello world!";

  // Create a peer connection with basic logging and public STUN
  const ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
  ];
  if (window.TURN && window.TURN.urls) {
    ICE.push({ urls: window.TURN.urls, username: window.TURN.username, credential: window.TURN.credential });
  }
  const pc = new RTCPeerConnection({ iceServers: ICE });
  window._pc = pc; // expose for debugging

  pc.onconnectionstatechange = () => console.log("PC connectionState:", pc.connectionState);
  pc.oniceconnectionstatechange = () => console.log("PC iceConnectionState:", pc.iceConnectionState);
  pc.onicegatheringstatechange = () => console.log("PC iceGatheringState:", pc.iceGatheringState);
  pc.onicecandidate = (e) => {
    pc.addEventListener("icecandidateerror", (ev) => {
      console.warn("ICE candidate error:", ev.errorText || ev.errorCode, ev.url || "");
    });
    if (e.candidate) console.log("ICE candidate:", e.candidate.type, e.candidate.protocol);
    else console.log("ICE candidate gathering complete");
  };

  // Set up to play remote audio from the model
  const audioElement = document.createElement("audio");
  audioElement.autoplay = true;
  document.body.appendChild(audioElement);
  pc.ontrack = (e) => {
    console.log("Received remote track");
    audioElement.srcObject = e.streams[0];
    audioElement.play().catch(() => {/* ignore autoplay blocks */});
  };

  // Add local audio track for microphone input in the browser
  console.log("Requesting microphone...");
  const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
  console.log("Microphone granted. Tracks:", ms.getTracks().map(t => t.kind+":"+t.readyState));
  pc.addTrack(ms.getTracks()[0]);

  // Set up data channel for sending and receiving events
  const dc = pc.createDataChannel("oai-events");
  dc.onopen = () => {
    console.log("Data channel open");
  };

  // Accumulate function call arguments for tool calls
  const pendingArgs = new Map();

  async function runShell(args, callId) {
    // UI log area
    const logEl = document.getElementById('log');
    const clearBtn = document.getElementById('clear');
    if (clearBtn && !clearBtn._bound) {
      clearBtn._bound = true;
      clearBtn.addEventListener('click', () => { if (logEl) logEl.textContent = ''; });
    }
    const cmd = args?.command || '';
    if (logEl) { logEl.textContent += `$ ${cmd}\n`; logEl.scrollTop = logEl.scrollHeight; }

    try {
      const r = await fetch('/tools/shell/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let out = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        out += chunk;
        if (logEl) { logEl.textContent += chunk; logEl.scrollTop = logEl.scrollHeight; }
      }
      // Send function output back to the model in the newer Realtime schema
      const textOut = out.trim() || '(no output)';
      const itemEvent = {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: [ { type: 'output_text', text: textOut } ],
        }
      };
      console.log('Sending conversation.item.create for function output', itemEvent);
      dc.send(JSON.stringify(itemEvent));
      const continueEvent = { type: 'response.create' };
      console.log('Sending response.create to continue');
      dc.send(JSON.stringify(continueEvent));
    } catch (err) {
      const text = `ERROR: ${(err && err.message) || String(err)}`;
      if (logEl) { logEl.textContent += `\n${text}\n`; logEl.scrollTop = logEl.scrollHeight; }
      const itemEvent = {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: [ { type: 'output_text', text } ],
        }
      };
      console.log('Sending conversation.item.create (error) for function output', itemEvent);
      dc.send(JSON.stringify(itemEvent));
      const continueEvent = { type: 'response.create' };
      console.log('Sending response.create to continue after error');
      dc.send(JSON.stringify(continueEvent));
    }
  }

  dc.onmessage = async (event) => {
    try {
      if (typeof event.data === 'string') {
        console.log('DC message raw:', event.data.slice(0, 300));
      } else {
        console.log('DC message (binary, len):', event.data?.byteLength || 0);
      }
    } catch (e) { console.warn('DC log failed', e); }


  try {
    // Some events may be binary (audio). Only handle JSON strings here.
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data);
    console.log('DC message type:', msg?.type, msg);

    // Handle function call args streaming (new schema)
    if (msg && msg.type === "response.function_call_arguments.delta") {
      const id = msg.call_id;
      const d = msg.delta || "";
      pendingArgs.set(id, (pendingArgs.get(id) || "") + d);
      return;
    }
    if (msg && msg.type === "response.function_call_arguments.done") {
      const id = msg.call_id;
      const name = msg.name;
      let argsStr = msg.arguments || pendingArgs.get(id) || "";
      pendingArgs.delete(id);
      let args = {};
      try { args = argsStr ? JSON.parse(argsStr) : {}; } catch(e) { console.warn("bad function args JSON", e, argsStr); args = {}; }
      if (name === "run_shell") {
        await runShell(args, id);
      }
      return;
    }

    if (!msg || typeof msg !== "object") return;

    // Handle tool calls from the model
    if (msg.type === "tool_call" && msg.name === "run_shell") {
      const callId = msg.id || msg.tool_call_id || msg.call_id;
      const args = msg.arguments || {};
      console.log("Received tool_call run_shell:", { callId, args });

      // Log area
      const log = document.getElementById('log');
      const clearBtn = document.getElementById('clear');
      if (clearBtn && !clearBtn._bound) {
        clearBtn._bound = true;
        clearBtn.addEventListener('click', () => { if (log) log.textContent = ''; });
      }

      const cmd = args.command || '';
      if (log) { log.textContent += `$ ${cmd}
`; log.scrollTop = log.scrollHeight; }

      try {
        // Use streaming endpoint so output appears live in the page
        const r = await fetch("/tools/shell/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let out = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          out += chunk;
          if (log) { log.textContent += chunk; log.scrollTop = log.scrollHeight; }
        }

        const resultEvent = {
          type: "tool_result",
          tool_call_id: callId,
          name: "run_shell",
          content: [
            { type: "output_text", text: out.trim() || "(no output)" },
          ],
          is_error: false,
        };
        dc.send(JSON.stringify(resultEvent));
      } catch (err) {
        const text = `ERROR: ${(err && err.message) || String(err)}`;
        if (log) { log.textContent += `
${text}
`; log.scrollTop = log.scrollHeight; }
        const fallback = {
          type: "tool_result",
          tool_call_id: callId,
          name: "run_shell",
          content: [
            { type: "output_text", text },
          ],
          is_error: true,
        };
        dc.send(JSON.stringify(fallback));
      }
    }
  } catch (e) {
    console.warn("Failed to handle data channel message:", e);
  }

  };

  // Start the session using the Session Description Protocol (SDP)
  console.log("Creating offer...");
  await pc.setLocalDescription(await pc.createOffer());

  // Wait for ICE gathering to complete so the SDP includes candidates
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });

  const local = pc.localDescription;
  console.log("Sending /session with SDP size:", local?.sdp?.length || 0);
  const sdpResponse = await fetch("/session", {
      method: "POST",
      body: local.sdp,
      headers: {
          "Content-Type": "application/sdp",
      },
  });
  console.log("/session status:", sdpResponse.status);
  const sdpText = await sdpResponse.text();
  if (!sdpResponse.ok) {
    console.error("/session error body:", sdpText.slice(0, 500));
    throw new Error("/session failed");
  }

  const answer = { type: "answer", sdp: sdpText };
  console.log('Answer object:', answer);
  await pc.setRemoteDescription(answer).catch(e => {
    console.error("setRemoteDescription failed:", e);
    throw e;
  });
  console.log("Remote description set.");
}

main().catch(err => {
  console.error("Fatal error in rtc.js:", err);
});
