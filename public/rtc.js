async function main() {
  function log(msg, extra) {
    try {
      if (extra !== undefined) console.log('[voice-agent]', msg, extra); else console.log('[voice-agent]', msg);
    } catch (e) {}
    if (extra === undefined) extra = '';
    const payload = { Msg: String(msg), Req: JSON.stringify(extra) };
    fetch('/log', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		}).catch((a) => {
       console.error(a);
		});
	};

  // Update heading
  const myHeading = document.querySelector('h1');
  if (myHeading) myHeading.textContent = 'Hello world!';
  const readyDot = document.getElementById('ready-dot');
  const readyText = document.getElementById('ready-text');
  function setReady(ok, msg){
    try{
      if (readyDot) readyDot.style.background = ok ? '#0a0' : '#a00';
      if (readyText) readyText.textContent = msg || (ok ? 'Ready' : 'Initializing...');
    }catch(_){}
  }
  setReady(false, 'Initializing...');

  // Peer connection with public STUN
  const ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
  ];
  if (window.TURN && window.TURN.urls) {
    ICE.push({ urls: window.TURN.urls, username: window.TURN.username, credential: window.TURN.credential });
  }
  const pc = new RTCPeerConnection({ iceServers: ICE });
  window._pc = pc;
  log('created rtc peer', '');

  // Resolve when a server-reflexive candidate appears (often indicates we have usable network path)
  let resolveSrflx;
  const srflxReady = new Promise((resolve) => { resolveSrflx = resolve; });

  pc.onconnectionstatechange = () => log('PC connectionState:', pc.connectionState);
  pc.oniceconnectionstatechange = () => log('PC iceConnectionState:', pc.iceConnectionState);
  pc.onicegatheringstatechange = () => log('PC iceGatheringState:', pc.iceGatheringState);
  pc.onicecandidate = (e) => {
    pc.addEventListener('icecandidateerror', (ev) => {
      console.warn('ICE candidate error:', ev.errorText || ev.errorCode, ev.url || '');
    });
    if (e.candidate) {
      log('ICE candidate:', e.candidate.type, e.candidate.protocol);
      try {
        if (e.candidate.type === 'srflx' && resolveSrflx) { resolveSrflx(); resolveSrflx = null; }
      } catch (_) {}
    }
    else log('ICE candidate gathering complete');
  };

  // Audio playback for model output
  const audioElement = document.createElement('audio');
  audioElement.autoplay = true;
  document.body.appendChild(audioElement);
  pc.ontrack = (e) => {
    console.log('Received remote track');
    audioElement.srcObject = e.streams[0];
    audioElement.play().catch(() => {});
  };

  // Microphone
  log('Requesting microphone...');
  const ms = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
  });
  const localTrack = ms.getAudioTracks()[0];
  localTrack.enabled = true;

  let ttsActive = false;
  const ttsStart = () => {
    if (!ttsActive) {
      ttsActive = true;
      try { localTrack.enabled = false; log('Mic muted (TTS start)'); } catch (_) {}
    }
  };
  const ttsStop = () => {
    if (ttsActive) {
      ttsActive = false;
      try { localTrack.enabled = true; log('Mic unmuted (TTS stop)'); } catch (_) {}
    }
  };

  let userMuted = false;
  function applyMicState() {
    const effective = userMuted === false && ttsActive === false;
    log('mic set to', effective);
    try { localTrack.enabled = effective; } catch (_) {}
    const btn = document.getElementById('mic-toggle');
    if (btn) btn.textContent = 'Mic: ' + (effective ? 'ON' : (userMuted ? 'OFF (user)' : 'OFF'));
  }

  log('Microphone granted. Tracks:', ms.getTracks().map((t) => t.kind + ':' + t.readyState));
  pc.addTrack(ms.getTracks()[0]);

  try {
    const btn = document.getElementById('mic-toggle');
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', () => {
        userMuted = !userMuted;
        log('Mic toggle: userMuted=' + userMuted);
        applyMicState();
        if (readyText) readyText.textContent = (userMuted ? 'Mic OFF (user)' : 'Ready. Start speaking.');
      });
    }
  } catch (_) {}
  applyMicState();

  // Data channel
  const dc = pc.createDataChannel('oai-events');
  dc.onopen = () => { log('Data channel open'); setReady(true, 'Ready. Start speaking.'); };
  const transcriptEl = document.getElementById('transcript');
  function appendTranscript(role, text) {
    try {
      if (!transcriptEl) return;
      const row = document.createElement('div');
      row.style.margin = '0.25rem 0';
      const who = document.createElement('span');
      who.style.color = role === 'user' ? '#9cf' : '#c9f';
      who.style.fontWeight = '600';
      who.textContent = role === 'user' ? 'User: ' : 'Agent: ';
      const span = document.createElement('span');
      span.textContent = String(text || '');
      row.appendChild(who);
      row.appendChild(span);
      transcriptEl.appendChild(row);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    } catch (_) {}
  }


  function normalizeUptime(text) {
    try {
      const t = String(text || '').trim();
      if (!t) return t;
      if (t.startsWith('up ')) return t; // already pretty
      const idx = t.indexOf(' up ');
      if (idx === -1) return t;
      let after = t.slice(idx + 4);
      // cut at ' user', ' users', or 'load average'
      const stops = [' user', ' users', 'load average'];
      let stop = after.length;
      for (const key of stops) {
        const i = after.indexOf(key);
        if (i !== -1 && i < stop) stop = i;
      }
      after = after.slice(0, stop).trim().replace(/^,\s*/, '').replace(/\s+,/g, ',');
      // Convert HH:MM into 'H hours, M minutes'
      const m = after.match(/(\d+):(\d{2})/);
      if (m) {
        const h = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const parts = [];
        if (!isNaN(h)) parts.push(h + ' hour' + (h === 1 ? '' : 's'));
        if (!isNaN(mm) && mm > 0) parts.push(mm + ' minute' + (mm === 1 ? '' : 's'));
        after = after.replace(m[0], parts.join(', '));
      }
      return ('up ' + after).trim();
    } catch (_) { return String(text || ''); }
  }
  // Accumulate function call args
  const pendingArgs = new Map();

  function displayCmd(c) {
    if (Array.isArray(c)) return c.join(' ');
    return String(c ?? '');
  }

  async function runShell(args, callId, responseId) {
    const logEl = document.getElementById('log');
    const clearBtn = document.getElementById('clear');
    if (clearBtn && !clearBtn._bound) {
      clearBtn._bound = true;
      clearBtn.addEventListener('click', () => { if (logEl) logEl.textContent = ''; });
    }

    const cmd = args?.command;
    const shown = displayCmd(cmd);
    if (logEl) { logEl.textContent += `$ ${shown}\n`; logEl.scrollTop = logEl.scrollHeight; }

    log('starting tool call', shown);
    try {
      const payload = { command: cmd };
      const r = await fetch('/tools/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error(`/tools HTTP ${r.status}`);
      const data = await r.json();
      const b64ToUtf8 = (s) => {
        try {
          if (!s) return '';
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder().decode(bytes);
        } catch (_) { return String(s || ''); }
      };
      const stdoutRaw = (data.stdout !== undefined ? data.stdout : data.Stdout);
      const stderrRaw = (data.stderr !== undefined ? data.stderr : data.Stderr);
      const stdout = typeof stdoutRaw === 'string' ? b64ToUtf8(stdoutRaw) : String(stdoutRaw || '');
      const stderr = typeof stderrRaw === 'string' ? b64ToUtf8(stderrRaw) : String(stderrRaw || '');
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\n' : '');
      if (combined) {
        if (logEl) { logEl.textContent += combined + '\n'; logEl.scrollTop = logEl.scrollHeight; }
      } else {
        if (logEl) { logEl.textContent += '(no output)\n'; logEl.scrollTop = logEl.scrollHeight; }
      }

      const code = (data.exitCode !== undefined ? data.exitCode : data.ExitCode);
      const ok = (data.ok !== undefined ? data.ok : data.OK);
      const errStr = (data.error !== undefined ? data.error : data.Error) || "";
      const textOut = (combined || "(no output)").trim();
      const summary = ok ? "SUCCESS" : `FAIL (exit ${code})`;
      const details = errStr ? `
Error: ${errStr}` : "";
      const cmdArr = Array.isArray(args?.command) ? args.command : [];
      const isUptime = cmdArr[0] === 'uptime';
      const outputForModel = isUptime ? normalizeUptime(textOut) : textOut;
      const outEvent = { type: 'response.function_call_output', call_id: callId, output: outputForModel } ;
      log('Sending function_call_output', outEvent);
      dc.send(JSON.stringify(outEvent));
      await new Promise((r) => setTimeout(r, 80));
      const continueEvent = { type: 'response.create' };
      log('Sending response.create to continue', continueEvent);
      dc.send(JSON.stringify(continueEvent));
    } catch (err) {
      const text = `ERROR: ${(err && err.message) || String(err)}`;
      if (logEl) { logEl.textContent += `\n${text}\n`; logEl.scrollTop = logEl.scrollHeight; }
      const appendEvent = { type: 'input_text.delta', text: `Tool run_shell error (call ${callId}):\n${text}` };
      log('Sending input_text.delta with tool error', appendEvent);
      dc.send(JSON.stringify(appendEvent));
      const commitEvent = { type: 'input_text.commit' };
      dc.send(JSON.stringify(commitEvent));
      const continueEvent = { type: 'response.create' };
      log('Sending response.create to continue after error');
      dc.send(JSON.stringify(continueEvent));
    }
    log('tool call finished');
  }

  dc.onmessage = async (event) => {
    try {
      if (typeof event.data === 'string') console.log('DC message raw:', event.data.slice(0, 300));
      else console.log('DC message (binary, len):', event.data?.byteLength || 0);
    } catch (e) { console.warn('DC log failed', e); }

    try {
      if (typeof event.data !== 'string') return;
      const msg = JSON.parse(event.data);
      console.log('DC message type:', msg?.type);

      // Capture user speech recognized by the model
      if (msg && msg.type === 'conversation.item.input_audio_transcription.completed') {
        const text = msg?.transcript || msg?.text || '';
        if (text) appendTranscript('user', text);
        return;
      }

      if (msg && msg.type === 'response.function_call_arguments.delta') {
        const id = msg.call_id;
        const d = msg.delta || '';
        pendingArgs.set(id, (pendingArgs.get(id) || '') + d);
        return;
      }

      if (msg && msg.type === 'response.function_call_arguments.done') {
        const id = msg.call_id;
        const responseId = msg.response_id;
        const name = msg.name;
        let argsStr = msg.arguments || pendingArgs.get(id) || '';
        pendingArgs.delete(id);
        let args = {};
        try { args = argsStr ? JSON.parse(argsStr) : {}; }
        catch (e) { log('bad function args JSON', e, argsStr); args = {}; }
        // Cancel any in-progress response to avoid speaking before tool results
        try {
          if (responseId) {
            const cancel = { type: 'response.cancel', response_id: responseId };
            log('Sending response.cancel for pending response', cancel);
            dc.send(JSON.stringify(cancel));
          }
        } catch (_) {}
        if (name === 'run_shell') await runShell(args, id, responseId);
        return;
      }

      if (!msg || typeof msg !== 'object') return;

      // Capture agent TTS transcript events (audio transcript)
      if (msg.type === 'response.output_audio_transcript.delta' && msg?.delta) { appendTranscript('agent', msg.delta); }
      if (msg.type === 'response.output_audio_transcript.done' && msg?.transcript) { appendTranscript('agent', msg.transcript); }

      // Half-duplex gating based on audio events
      try {
        if (msg.type === 'output_audio_buffer.started' || msg.type === 'response.output_audio_transcript.delta') ttsStart();
        if (msg.type === 'response.output_audio.done' || msg.type === 'output_audio_buffer.cleared' || msg.type === 'response.output_audio_transcript.done' || msg.type === 'response.done') ttsStop();
      } catch (_) {}
    } catch (e) {
      console.warn('Failed to handle data channel message:', e);
    }
  };

  // SDP Offer/Answer
  console.log('Creating offer...');
  await pc.setLocalDescription(await pc.createOffer());
  // Proceed when ICE completes, or we have at least one srflx candidate, or after a short timeout.
  const iceComplete = new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
  await Promise.race([
    iceComplete,
    srflxReady,
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);

  const local = pc.localDescription;
  console.log('Sending /session with SDP size:', local?.sdp?.length || 0);
  const sdpResponse = await fetch('/session', {
    method: 'POST',
    body: local.sdp,
    headers: { 'Content-Type': 'application/sdp' }
  });
  console.log('/session status:', sdpResponse.status);
  const sdpText = await sdpResponse.text();
  if (!sdpResponse.ok) {
    console.error('/session error body:', sdpText.slice(0, 500));
    throw new Error('/session failed');
  }

  const answer = { type: 'answer', sdp: sdpText };
  console.log('Answer object:', answer);
  await pc.setRemoteDescription(answer).catch((e) => { console.error('setRemoteDescription failed:', e); setReady(false, 'Connection failed'); throw e; });
  console.log('Remote description set.');
}

main().catch((err) => { console.error('Fatal error in rtc.js:', err); });
