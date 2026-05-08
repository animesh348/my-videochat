// ── STATE ──────────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" }
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
let reconnectAttempts = 0;

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

// ── WEBSOCKET URL ────────────────────────────────────────────────
function getWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

// ── SESSION CONTROL ─────────────────────────────────────────────
function startSession() {
  if (!localStream) { showToast('Camera not available.'); return; }
  sessionActive = true;
  reconnectAttempts = 0;
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'flex';
  document.getElementById('nextBtn').disabled = false;
  connect();
}

function stopSession() {
  sessionActive = false;
  hangup();
  if (ws) { try { ws.close(); } catch(e){} ws = null; }
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
  if (ws) { try { ws.close(); } catch(e){} ws = null; }
  showWaiting('Looking for someone...');
  setStatus('waiting', 'Searching...');

  try { ws = new WebSocket(getWsUrl()); }
  catch(e) {
    if (sessionActive) setTimeout(connect, 3000);
    return;
  }

  ws.onopen = () => { reconnectAttempts = 0; setStatus('waiting', 'Waiting for match...'); };

  ws.onmessage = async ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch(e) { return; }

    if (msg.type === 'waiting') { showWaiting('Waiting for a stranger...'); setStatus('waiting', 'Matching...'); }

    if (msg.type === 'matched') {
      roomId = msg.room; myRole = msg.role;
      strangerCount++;
      document.getElementById('infoCount').textContent = strangerCount;
      hideWaiting();
      setStatus('connected', 'Connected');
      addSystemMsg('Connected to a stranger! Say hello 👋');
      document.getElementById('nameTag').classList.add('visible');
      startTimer();
      document.getElementById('infoStatus').textContent = 'Connected';
      document.getElementById('infoConn').textContent = 'WebRTC P2P';
      await startCall();
    }

    if (msg.type === 'offer') {
      await setupPC();
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      send({ type: 'answer', sdp: ans, room: roomId });
    }

    if (msg.type === 'answer' && pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    if (msg.type === 'ice' && pc) { try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch(e){} }
    if (msg.type === 'chat') addChatMsg(msg.text, 'them');

    if (msg.type === 'peer_disconnected') {
      addSystemMsg('Stranger disconnected.');
      setStatus('waiting', 'Disconnected');
      document.getElementById('nameTag').classList.remove('visible');
      document.getElementById('remote').srcObject = null;
      stopTimer();
      if (pc) { pc.close(); pc = null; }
      document.getElementById('infoStatus').textContent = 'Stranger left';
      document.getElementById('infoConn').textContent = '—';
      if (sessionActive) setTimeout(() => { addSystemMsg('Finding next stranger...'); connect(); }, 1500);
    }
  };

  ws.onerror = () => { if (sessionActive) showToast('Connection error. Retrying...'); };
  ws.onclose = () => {
    if (sessionActive) {
      reconnectAttempts++;
      setTimeout(() => { if (sessionActive) connect(); }, Math.min(1000 * reconnectAttempts, 5000));
    }
  };
}

async function setupPC() {
  if (pc) { pc.close(); }
  pc = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => { document.getElementById('remote').srcObject = e.streams[0]; };
  pc.onicecandidate = e => { if (e.candidate) send({ type: 'ice', candidate: e.candidate, room: roomId }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { document.getElementById('infoConn').textContent = 'P2P Direct ✓'; showToast('✅ Video connected!'); }
    if (pc.connectionState === 'failed' && sessionActive) setTimeout(connect, 1000);
  };
}

async function startCall() {
  await setupPC();
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

function send(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

// ── CHAT ────────────────────────────────────────────────────────
function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!roomId) { showToast('Connect to someone first!'); return; }
  send({ type: 'chat', text, room: roomId });
  addChatMsg(text, 'me');
  input.value = ''; input.style.height = 'auto';
}

function addChatMsg(text, who) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `msg ${who}`; div.textContent = text;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
  if (!document.getElementById('tab-chat').classList.contains('active') && who === 'them') showToast('💬 New message!');
}

function addSystemMsg(text) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'msg system'; div.textContent = text;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
}

function handleChatKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }

// ── MEDIA ────────────────────────────────────────────────────────
function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  const btn = document.getElementById('micBtn');
  const icon = document.getElementById('micIcon');
  if (micEnabled) {
    btn.classList.replace('btn-muted-state', 'btn-ghost');
    icon.innerHTML = '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    showToast('🎙️ Mic on');
  } else {
    btn.classList.replace('btn-ghost', 'btn-muted-state');
    icon.innerHTML = '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    showToast('🔇 Mic muted');
  }
}

function toggleCamera() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById('camBtn');
  if (camEnabled) { btn.classList.replace('btn-muted-state', 'btn-ghost'); showToast('📷 Camera on'); }
  else { btn.classList.replace('btn-ghost', 'btn-muted-state'); showToast('📷 Camera off'); }
}

function toggleFullscreen() {
  const stage = document.querySelector('.video-stage');
  if (!document.fullscreenElement) stage.requestFullscreen().catch(() => showToast('Fullscreen not supported'));
  else document.exitFullscreen();
}

async function togglePiP() {
  try {
    const video = document.getElementById('remote');
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (video.srcObject) await video.requestPictureInPicture();
    else showToast('No remote video to pop out');
  } catch(e) { showToast('PiP not supported in this browser'); }
}

function expandPip() {
  pipExpanded = !pipExpanded;
  document.getElementById('localPip').classList.toggle('pip-expanded', pipExpanded);
}

// ── TABS ────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && name === 'chat') || (i === 1 && name === 'info'));
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
}

function toggleMobileChat() {
  document.querySelector('.side-panel').classList.toggle('mobile-open');
}

// ── TIMER ────────────────────────────────────────────────────────
function startTimer() {
  sessionStart = Date.now(); stopTimer();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - sessionStart) / 1000);
    const t = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    document.getElementById('timerDisplay').textContent = t;
    document.getElementById('infoDuration').textContent = t;
  }, 1000);
}
function stopTimer() { clearInterval(timerInterval); document.getElementById('timerDisplay').textContent = '00:00'; }

// ── STATUS ────────────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot';
  if (type === 'connected') dot.classList.add('connected');
  if (type === 'waiting') dot.classList.add('waiting');
  document.getElementById('statusText').textContent = text;
}

function showWaiting(msg) { document.getElementById('waiting-overlay').classList.remove('hidden'); document.getElementById('waitingMsg').textContent = msg; }
function hideWaiting() { document.getElementById('waiting-overlay').classList.add('hidden'); }

// ── REPORT / BLOCK ────────────────────────────────────────────────
function openReport() { if (!roomId) { showToast('No active session'); return; } document.getElementById('reportModal').classList.add('open'); }
function closeReport() { document.getElementById('reportModal').classList.remove('open'); }
function submitReport() {
  const reason = document.getElementById('reportReason').value;
  if (!reason) { showToast('Please select a reason'); return; }
  fetch('/report', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ room: roomId, reason, details: document.getElementById('reportDetails').value }) }).catch(()=>{});
  closeReport(); showToast('✅ Report submitted.'); addSystemMsg('You reported this user.');
  setTimeout(() => nextMatch(), 800);
}
function blockUser() { if (!roomId) { showToast('No active session'); return; } showToast('🚫 Blocked. Finding next...'); addSystemMsg('You blocked this user.'); setTimeout(() => nextMatch(), 800); }

// ── TOAST ────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
