// ── STATE ──────────────────────────────────────────────────────
const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ]
};

let ws, pc, stream;
let roomId = null, myRole = null;
let micOn = true, camOn = true;
let active = false;
let metCount = 0;
let timerStart = null, timerInterval = null;
let retries = 0;

// ── BOOT ────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('local').srcObject = stream;
    setStatus('idle', 'Ready');
  } catch {
    toast('⚠️ Camera/mic denied — check browser permissions');
    setStatus('idle', 'No camera');
  }
});

// ── WS URL ──────────────────────────────────────────────────────
const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// ── SESSION ──────────────────────────────────────────────────────
function startSession() {
  if (!stream) { toast('Camera not available'); return; }
  active = true; retries = 0;
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display  = 'flex';
  document.getElementById('nextBtn').disabled = false;
  connect();
}

function stopSession() {
  active = false;
  hangup();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  stopTimer();
  document.getElementById('startBtn').style.display = 'flex';
  document.getElementById('stopBtn').style.display  = 'none';
  document.getElementById('nextBtn').disabled = true;
  showOverlay('Click "Start" to find someone');
  setStatus('idle', 'Disconnected');
  sysMsg('Session ended.');
  setInfo('Idle', '—', '—');
}

function nextMatch() {
  if (!active) return;
  hangup();
  sysMsg('Finding next stranger...');
  connect();
}

// ── CONNECT ──────────────────────────────────────────────────────
function connect() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  showOverlay('Looking for someone...');
  setStatus('waiting', 'Searching...');

  try { ws = new WebSocket(wsUrl()); } catch {
    if (active) setTimeout(connect, 3000);
    return;
  }

  ws.onopen = () => { retries = 0; setStatus('waiting', 'Waiting...'); };

  ws.onmessage = async ({ data }) => {
    let m; try { m = JSON.parse(data); } catch { return; }

    if (m.type === 'waiting') { showOverlay('Waiting for a stranger...'); }

    if (m.type === 'matched') {
      roomId = m.room; myRole = m.role;
      metCount++;
      updateCounters();
      hideOverlay();
      setStatus('connected', 'Connected');
      sysMsg('Connected to a stranger! Say hello 👋');
      document.getElementById('nameTag').classList.add('visible');
      startTimer();
      setInfo('Connected', null, 'WebRTC P2P');
      await startCall();
    }

    if (m.type === 'offer')  { await onOffer(m); }
    if (m.type === 'answer' && pc) { await pc.setRemoteDescription(new RTCSessionDescription(m.sdp)); }
    if (m.type === 'ice' && pc)    { try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {} }
    if (m.type === 'chat')   { addMsg(m.text, 'them'); }

    if (m.type === 'peer_disconnected') {
      sysMsg('Stranger disconnected.');
      setStatus('waiting', 'Disconnected');
      document.getElementById('nameTag').classList.remove('visible');
      document.getElementById('remote').srcObject = null;
      stopTimer();
      if (pc) { pc.close(); pc = null; }
      setInfo('Stranger left', null, '—');
      if (active) setTimeout(() => { sysMsg('Finding next...'); connect(); }, 1500);
    }
  };

  ws.onerror = () => { if (active) toast('Connection error, retrying...'); };
  ws.onclose = () => {
    if (active) { retries++; setTimeout(() => { if (active) connect(); }, Math.min(retries * 1000, 5000)); }
  };
}

// ── WEBRTC ──────────────────────────────────────────────────────
async function makePC() {
  if (pc) { pc.close(); pc = null; }
  pc = new RTCPeerConnection(ICE);
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  pc.ontrack = e => { document.getElementById('remote').srcObject = e.streams[0]; };
  pc.onicecandidate = e => { if (e.candidate) send({ type:'ice', candidate: e.candidate, room: roomId }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { setInfo(null, null, 'P2P Direct ✓'); toast('✅ Video connected!'); }
    if (pc.connectionState === 'failed' && active) setTimeout(connect, 1000);
  };
}

async function startCall() {
  await makePC();
  if (myRole === 'caller') {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type:'offer', sdp: offer, room: roomId });
  }
}

async function onOffer(m) {
  await makePC();
  await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  send({ type:'answer', sdp: ans, room: roomId });
}

function hangup() {
  if (pc) { pc.close(); pc = null; }
  roomId = null; myRole = null;
  document.getElementById('remote').srcObject = null;
  document.getElementById('nameTag').classList.remove('visible');
  stopTimer();
  showOverlay('Looking for someone...');
}

function send(m) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); }

// ── CHAT ────────────────────────────────────────────────────────
function sendChat() {
  const el = document.getElementById('chatIn');
  const txt = el.value.trim();
  if (!txt || !roomId) { if (!roomId) toast('Connect first!'); return; }
  send({ type:'chat', text: txt, room: roomId });
  addMsg(txt, 'me');
  el.value = ''; el.style.height = 'auto';
}

function sendMChat() {
  const el = document.getElementById('mChatIn');
  const txt = el.value.trim();
  if (!txt || !roomId) { if (!roomId) toast('Connect first!'); return; }
  send({ type:'chat', text: txt, room: roomId });
  addMsg(txt, 'me');
  el.value = ''; el.style.height = 'auto';
}

function addMsg(text, who) {
  // add to both desktop and mobile message lists
  ['msgs', 'mmsgs'].forEach(id => {
    const box = document.getElementById(id);
    if (!box) return;
    const d = document.createElement('div');
    d.className = `msg ${who}`; d.textContent = text;
    box.appendChild(d); box.scrollTop = box.scrollHeight;
  });
  if (who === 'them') toast('💬 New message!');
}

function sysMsg(text) {
  ['msgs', 'mmsgs'].forEach(id => {
    const box = document.getElementById(id);
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'msg sys'; d.textContent = text;
    box.appendChild(d); box.scrollTop = box.scrollHeight;
  });
}

function handleKey(e)  { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }
function handleMKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMChat(); } }
function resize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }

// ── MEDIA ────────────────────────────────────────────────────────
function toggleMic() {
  if (!stream) return;
  micOn = !micOn;
  stream.getAudioTracks().forEach(t => t.enabled = micOn);
  const btn = document.getElementById('micBtn');
  const ico = document.getElementById('micIco');
  if (micOn) {
    btn.classList.replace('muted-state', 'ghost');
    ico.innerHTML = '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    toast('🎙️ Mic on');
  } else {
    btn.classList.replace('ghost', 'muted-state');
    ico.innerHTML = '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    toast('🔇 Mic muted');
  }
}

function toggleCam() {
  if (!stream) return;
  camOn = !camOn;
  stream.getVideoTracks().forEach(t => t.enabled = camOn);
  const btn = document.getElementById('camBtn');
  if (camOn) { btn.classList.replace('muted-state', 'ghost'); toast('📷 Camera on'); }
  else        { btn.classList.replace('ghost', 'muted-state'); toast('📷 Camera off'); }
}

function goFullscreen() {
  const el = document.querySelector('.video-wrap');
  if (!document.fullscreenElement) el.requestFullscreen().catch(() => toast('Fullscreen not supported'));
  else document.exitFullscreen();
}

async function goPiP() {
  const v = document.getElementById('remote');
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (v.srcObject) await v.requestPictureInPicture();
    else toast('No remote video yet');
  } catch { toast('PiP not supported here'); }
}

// ── TABS ────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.side-panel .tab').forEach((t,i) =>
    t.classList.toggle('active', (i===0 && name==='chat') || (i===1 && name==='opts')));
  ['pane-chat','pane-opts'].forEach(id =>
    document.getElementById(id).classList.toggle('active', id === `pane-${name}`));
}

function switchMobileTab(name) {
  document.querySelectorAll('.mobile-drawer .tab').forEach((t,i) =>
    t.classList.toggle('active', (i===0 && name==='chat') || (i===1 && name==='opts')));
  ['mpane-chat','mpane-opts'].forEach(id =>
    document.getElementById(id).classList.toggle('active', id === `mpane-${name}`));
}

// ── DRAWER (mobile) ──────────────────────────────────────────────
function toggleDrawer() {
  const d = document.getElementById('drawer');
  const b = document.getElementById('backdrop');
  const open = d.classList.toggle('open');
  b.style.display = open ? 'block' : 'none';
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('backdrop').style.display = 'none';
}

// ── TIMER ────────────────────────────────────────────────────────
function startTimer() {
  timerStart = Date.now(); stopTimer();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - timerStart) / 1000);
    const t = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    document.getElementById('timerDisplay').textContent = t;
    document.getElementById('iDur').textContent = t;
    const miDur = document.getElementById('miDur');
    if (miDur) miDur.textContent = t;
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  document.getElementById('timerDisplay').textContent = '00:00';
}

// ── STATUS / INFO ────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot';
  if (type === 'connected') dot.classList.add('connected');
  if (type === 'waiting')   dot.classList.add('waiting');
  document.getElementById('statusText').textContent = text;
}

function setInfo(status, duration, conn) {
  if (status)   { document.getElementById('iStatus').textContent = status; const m = document.getElementById('miStatus'); if(m) m.textContent = status; }
  if (duration) { document.getElementById('iDur').textContent = duration; }
  if (conn)     { document.getElementById('iConn').textContent = conn; }
}

function updateCounters() {
  document.getElementById('iCount').textContent = metCount;
  const m = document.getElementById('miCount'); if(m) m.textContent = metCount;
}

// ── OVERLAY ──────────────────────────────────────────────────────
function showOverlay(msg) {
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('overlayMsg').textContent = msg;
}
function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }

// ── REPORT / BLOCK ────────────────────────────────────────────────
function openReport()  { if (!roomId) { toast('No active session'); return; } document.getElementById('reportModal').classList.add('open'); }
function closeReport() { document.getElementById('reportModal').classList.remove('open'); }
function submitReport() {
  const reason = document.getElementById('reportReason').value;
  if (!reason) { toast('Select a reason first'); return; }
  fetch('/report', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ room: roomId, reason, details: document.getElementById('reportDetails').value })
  }).catch(()=>{});
  closeReport(); toast('✅ Reported. Skipping...'); sysMsg('You reported this user.');
  setTimeout(nextMatch, 800);
}
function blockUser() {
  if (!roomId) { toast('No active session'); return; }
  toast('🚫 Blocked. Skipping...'); sysMsg('You blocked this user.');
  setTimeout(nextMatch, 800);
}

// ── TOAST ────────────────────────────────────────────────────────
let toastT;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2800);
}
