async function main() {
  function log(msg, extra) {
    try {
      if (extra !== undefined) console.log('[voice-agent]', msg, extra); else console.log('[voice-agent]', msg);
    } catch(e){}
    if (extra === undefined) extra = '';
    const payload = { Msg: String(msg), Req: JSON.stringify(extra) };
    fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(()=>{});
  };

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
	log("created rtc peer", "")

  pc.onconnectionstatechange = () => console.log("PC connectionState:", pc.connectionState);
  pc.oniceconnectionstatechange = () => console.log("PC iceConnectionState:", pc.iceConnectionState);
  pc.onicegatheringstatechange = () => console.log("PC iceGatheringState:", pc.iceGatheringState);
  pc.onicecandidate = (e) => {
    pc.addEventListener("icecandidateerror", (ev) => {
      console.warn("ICE candidate error:", ev.errorText || ev.errorCode, ev.url || "");
    });
    if (e.candidate) console.log("ICE candidate:", e.candidate.type, e.candidate.protocol);
    else log("ICE candidate gathering complete");
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
  log("Requesting microphone...");
  const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
  const localTrack = ms.getAudioTracks()[0];
  localTrack.enabled = true;
  let ttsActive = false;
  const ttsStart = () => { if (!ttsActive) { ttsActive = true; try { localTrack.enabled = false; log("Mic muted (TTS start)"); } catch(_){} } };
  const ttsStop  = () => { if (ttsActive)  { ttsActive = false; try { localTrack.enabled = true;  log("Mic unmuted (TTS stop)"); } catch(_){} } };
  // User toggle state and unified mic state applier
  let userMuted = false;
  function applyMicState(){
    const effective = (userMuted==false) && (ttsActive==false);
    try { localTrack.enabled = effective; } catch(_){}
    const btn = document.getElementById("mic-toggle");
    if (btn) btn.textContent = "Mic: " + (effective ? "ON" : (userMuted ? "OFF (user)" : "OFF"));
  }

  log("Microphone granted. Tracks:", ms.getTracks().map(t => t.kind+":"+t.readyState));
  pc.addTrack(ms.getTracks()[0]);
  // Initialize mic toggle UI
  try { const btn = document.getElementById("mic-toggle"); if (btn && !btn._bound) { btn._bound = true; btn.addEventListener("click", ()=>{ userMuted = !userMuted; log("Mic toggle: userMuted="+userMuted); applyMicState(); }); } } catch(_){}
  applyMicState();

  // Set up data channel for sending and receiving events
  const dc = pc.createDataChannel("oai-events");
  dc.onopen = () => {
    log("Data channel open");
  };

  // Accumulate function call arguments for tool calls
  const pendingArgs = new Map();

  function base64ToText(b64) {
    if (!b64) return '';
    const binStr = atob(b64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function runShell(args, callId, responseId) {
    // UI log area
    const logEl = document.getElementById('log');
    const clearBtn = document.getElementById('clear');
    if (clearBtn && !clearBtn._bound) {
      clearBtn._bound = true;
      clearBtn.addEventListener('click', () => { if (logEl) logEl.textContent = ''; });
    }
    const cmd = args?.command || '';
    if (logEl) { logEl.textContent += `$ ${cmd}\n`; logEl.scrollTop = logEl.scrollHeight; }

		log("starting tool call", cmd)
    try {
      const payload = { Command: ["/bin/bash", "-lc", cmd] };
      const r = await fetch('/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`/tools HTTP ${r.status}`);
      const data = await r.json();
      const stdout = base64ToText(data.Stdout);
      const stderr = base64ToText(data.Stderr);
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      if (combined) {
        if (logEl) { logEl.textContent += combined + "\n"; logEl.scrollTop = logEl.scrollHeight; }
      } else {
        if (logEl) { logEl.textContent += "(no output)\n"; logEl.scrollTop = logEl.scrollHeight; }
      }
      // Send function output back to the model in the newer Realtime schema
      const textOut = (combined || '(no output)').trim();
      const appendEvent = { type: 'input_text.append', text: `Tool run_shell output (call ${callId}):\n${textOut}` };
      log('Sending input_text.append with tool output', appendEvent);
      dc.send(JSON.stringify(appendEvent));
      const continueEvent = { type: 'response.create' };
      log('Sending response.create to continue', continueEvent);
      dc.send(JSON.stringify(continueEvent));
    } catch (err) {
      const text = `ERROR: ${(err && err.message) || String(err)}`;
      if (logEl) { logEl.textContent += `\n${text}\n`; logEl.scrollTop = logEl.scrollHeight; }
      const appendEvent = { type: 'input_text.append', text: `Tool run_shell error (call ${callId}):\n${text}` };
      console.log('Sending input_text.append with tool error');
      dc.send(JSON.stringify(appendEvent));
      const continueEvent = { type: 'response.create' };
      console.log('Sending response.create to continue after error');
      dc.send(JSON.stringify(continueEvent));
    }
		log("tool call finished");
  }

  dc.onmessage = async (event) => {
    try {
      if (typeof event.data === 'string') {
        log('DC message raw:', event.data.slice(0, 300));
      } else {
        log('DC message (binary, len):', event.data?.byteLength || 0);
      }
    } catch (e) { log('DC log failed', e); }


  try {
    // Some events may be binary (audio). Only handle JSON strings here.
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data);
    log('DC message type:', msg?.type);
    // reduced verbose logging

    // Handle function call args streaming (new schema)
    if (msg && msg.type === "response.function_call_arguments.delta") {
      const id = msg.call_id;
      const d = msg.delta || "";
      pendingArgs.set(id, (pendingArgs.get(id) || "") + d);
      return;
    }
    if (msg && msg.type === "response.function_call_arguments.done") {
      const id = msg.call_id;
      const responseId = msg.response_id;
      const name = msg.name;
      let argsStr = msg.arguments || pendingArgs.get(id) || "";
      pendingArgs.delete(id);
      let args = {};
      try { args = argsStr ? JSON.parse(argsStr) : {}; } catch(e) { console.warn("bad function args JSON", e, argsStr); args = {}; }
      if (name === "run_shell") {
        await runShell(args, id, responseId);
      }
      return;
    }

    if (!msg || typeof msg !== "object") return;

    // Simple DC-event-based half-duplex gating
    try {
      if (msg.type === "response.output_audio.delta") ttsStart();
      if (msg.type === "response.output_audio.done" || msg.type === "output_audio_buffer.cleared" || msg.type === "response.done") ttsStop();
    } catch(_){}

    // Handle tool calls from the model
  // Legacy tool_call handler removed to use new Realtime schema only.

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
};

main().catch(err => {
  console.error("Fatal error in rtc.js:", err);
});
