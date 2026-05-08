// ── STATE ──────────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

let ws, pc, localStream;
let roomId = null, myRole = null;
let micEnabled = true, camEnabled = true;
let sessionActive = false;
let strangerCount = 0;
let sessionStart = null;
let timerInterval = null;
let pipExpanded = false;
let currentPartnerId = null;

// ── INIT ────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('local').srcObject = localStream;
    setStatus('idle', 'Ready');
  } catch (err) {
    showToast('⚠️ Camera/mic access denied. Please allow permissions.');
    setStatus('idle', 'No camera');
  }
});

// ── SESSION CONTROL ─────────────────────────────────────────────
function startSession() {
  if (!localStream) {
    showToast('Camera not available. Check browser permissions.');
    return;
  }
  sessionActive = true;
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'flex';
  document.getElementById('nextBtn').disabled = false;
  connect();
}

function stopSession() {
  sessionActive = false;
  hangup();
  if (ws) { ws.close(); ws = null; }
  stopTimer();
  document.getElementById('startBtn').style.display = 'flex';
  document.getElementById('stopBtn').style.display = 'none';
  document.getElementById('nextBtn').disabled = true;
  showWaiting('Click "Start" to find someone');
  setStatus('idle', 'Disconnected');
  addSystemMsg('Session ended.');
  document.getElementById('infoStatus').textContent = 'Idle';
  document.getElementById('infoDuration').textContent = '—';
  document.getElementById('infoConn').textContent = '—';
}

function nextMatch() {
  if (!sessionActive) return;
  hangup();
  addSystemMsg('Finding next stranger...');
  connect();
}

function connect() {
  if (ws) { try { ws.close(); } catch(e){} }
  showWaiting('Looking for someone...');
  setStatus('waiting', 'Searching...');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    setStatus('waiting', 'Waiting for match...');
  };

  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(data);

    if (msg.type === 'waiting') {
      showWaiting('Waiting for a stranger...');
      setStatus('waiting', 'Matching...');
    }

    if (msg.type === 'matched') {
      roomId = msg.room;
      myRole = msg.role;
      currentPartnerId = msg.room;
      strangerCount++;
      document.getElementById('infoCount').textContent = strangerCount;
      hideWaiting();
      setStatus('connected', 'Connected');
      addSystemMsg('Connected to a stranger! Say hello 👋');
      document.getElementById('nameTag').classList.add('visible');
      startTimer();
      document.getElementById('infoStatus').textContent = 'Connected';
      document.getElementById('infoConn').textContent = 'P2P WebRTC';
      await startCall();
    }

    if (msg.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'answer', sdp: answer, room: roomId });
    }

    if (msg.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    }

    if (msg.type === 'ice') {
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch(e){}
    }

    if (msg.type === 'chat') {
      addChatMsg(msg.text, 'them');
    }

    if (msg.type === 'peer_disconnected') {
      addSystemMsg('Stranger disconnected.');
      setStatus('waiting', 'Disconnected');
      document.getElementById('nameTag').classList.remove('visible');
      stopTimer();
      document.getElementById('infoStatus').textContent = 'Stranger left';
      document.getElementById('infoConn').textContent = '—';
      if (sessionActive) {
        setTimeout(() => {
          addSystemMsg('Finding next stranger...');
          connect();
        }, 1200);
      }
    }
  };

  ws.onerror = () => showToast('Connection error. Retrying...');
  ws.onclose = () => {
    if (sessionActive) setStatus('waiting', 'Reconnecting...');
  };
}

async function startCall() {
  pc = new RTCPeerConnection(ICE_SERVERS);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (e) => {
    document.getElementById('remote').srcObject = e.streams[0];
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', candidate: e.candidate, room: roomId });
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'connected') document.getElementById('infoConn').textContent = 'P2P Direct';
    if (state === 'failed') {
      showToast('Connection failed. Trying again...');
      if (sessionActive) connect();
    }
  };

  if (myRole === 'caller') {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'offer', sdp: offer, room: roomId });
  }
}

function hangup() {
  if (pc) { pc.close(); pc = null; }
  roomId = null; myRole = null;
  document.getElementById('remote').srcObject = null;
  document.getElementById('nameTag').classList.remove('visible');
  stopTimer();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── CHAT ────────────────────────────────────────────────────────
function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!roomId) { showToast('Connect to someone first!'); return; }
  send({ type: 'chat', text, room: roomId });
  addChatMsg(text, 'me');
  input.value = '';
  input.style.height = 'auto';
}

function addChatMsg(text, who) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  // Switch to chat tab if on options
  if (!document.getElementById('tab-chat').classList.contains('active') && who === 'them') {
    showToast('💬 New message from stranger');
  }
}

function addSystemMsg(text) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

// ── MEDIA CONTROLS ───────────────────────────────────────────────
function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  const btn = document.getElementById('micBtn');
  const icon = document.getElementById('micIcon');
  if (micEnabled) {
    btn.classList.remove('btn-muted-state');
    btn.classList.add('btn-ghost');
    icon.innerHTML = '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    showToast('🎙️ Mic on');
  } else {
    btn.classList.remove('btn-ghost');
    btn.classList.add('btn-muted-state');
    icon.innerHTML = '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    showToast('🔇 Mic muted');
  }
}

function toggleCamera() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById('camBtn');
  if (camEnabled) {
    btn.classList.remove('btn-muted-state');
    btn.classList.add('btn-ghost');
    showToast('📷 Camera on');
  } else {
    btn.classList.remove('btn-ghost');
    btn.classList.add('btn-muted-state');
    showToast('📷 Camera off');
  }
}

// ── FULLSCREEN ──────────────────────────────────────────────────
function toggleFullscreen() {
  const stage = document.querySelector('.video-stage');
  if (!document.fullscreenElement) {
    stage.requestFullscreen().catch(() => showToast('Fullscreen not supported'));
  } else {
    document.exitFullscreen();
  }
}

// ── PiP ─────────────────────────────────────────────────────────
async function togglePiP() {
  try {
    const video = document.getElementById('remote');
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (video.srcObject) {
      await video.requestPictureInPicture();
    } else {
      showToast('No remote video to pop out');
    }
  } catch(e) { showToast('PiP not supported in this browser'); }
}

function expandPip() {
  const pip = document.getElementById('localPip');
  pipExpanded = !pipExpanded;
  pip.classList.toggle('pip-expanded', pipExpanded);
}

// ── TABS ────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && name === 'chat') || (i === 1 && name === 'info'));
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
}

// ── TIMER ───────────────────────────────────────────────────────
function startTimer() {
  sessionStart = Date.now();
  stopTimer();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - sessionStart) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const t = `${mm}:${ss}`;
    document.getElementById('timerDisplay').textContent = t;
    document.getElementById('infoDuration').textContent = t;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  document.getElementById('timerDisplay').textContent = '00:00';
}

// ── STATUS ───────────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusText');
  dot.className = 'status-dot';
  if (type === 'connected') dot.classList.add('connected');
  if (type === 'waiting')   dot.classList.add('waiting');
  label.textContent = text;
}

// ── WAITING OVERLAY ──────────────────────────────────────────────
function showWaiting(msg) {
  const ov = document.getElementById('waiting-overlay');
  ov.classList.remove('hidden');
  document.getElementById('waitingMsg').textContent = msg;
}
function hideWaiting() {
  document.getElementById('waiting-overlay').classList.add('hidden');
}

// ── REPORT / BLOCK ───────────────────────────────────────────────
function openReport() {
  if (!roomId) { showToast('No active session to report'); return; }
  document.getElementById('reportModal').classList.add('open');
}
function closeReport() {
  document.getElementById('reportModal').classList.remove('open');
}
function submitReport() {
  const reason = document.getElementById('reportReason').value;
  if (!reason) { showToast('Please select a reason'); return; }
  // Send report to backend
  fetch('/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: roomId,
      reason,
      details: document.getElementById('reportDetails').value
    })
  }).catch(() => {});
  closeReport();
  showToast('✅ Report submitted. Skipping to next...');
  addSystemMsg('You reported this user.');
  setTimeout(() => nextMatch(), 800);
}

function blockUser() {
  if (!roomId) { showToast('No active session'); return; }
  showToast('🚫 User blocked. Finding next...');
  addSystemMsg('You blocked this user.');
  setTimeout(() => nextMatch(), 800);
}

// ── TOAST ────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
