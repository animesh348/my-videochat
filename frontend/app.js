// ── ICE CONFIG — Free Open Relay TURN (no account needed) ────────
const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

// ── STATE ────────────────────────────────────────────────────────
let ws, pc, stream;
let roomId = null, myRole = null;
let micOn = true, camOn = true;
let active = false;
let metCount = 0;
let timerStart = null, timerInterval = null;
let retries = 0;
let usingFrontCam = true;

// ── BOOT ────────────────────────────────────────────────────────
window.addEventListener('load', () => startCamera(true));

async function startCamera(front) {
  try {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: front ? 'user' : 'environment', width:{ideal:1280}, height:{ideal:720} }
    });
    document.getElementById('local').srcObject = stream;
    if (pc) {
      const vt = stream.getVideoTracks()[0];
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && vt) await sender.replaceTrack(vt);
    }
    setStatus('idle', 'Ready');
  } catch {
    toast('Camera/mic denied — check permissions');
    setStatus('idle', 'No camera');
  }
}

const wsUrl = () => `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`;

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
  active = false; hangup();
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
  hangup(); sysMsg('Finding next stranger...'); connect();
}

// ── CONNECT ──────────────────────────────────────────────────────
function connect() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  showOverlay('Looking for someone...');
  setStatus('waiting', 'Searching...');
  try { ws = new WebSocket(wsUrl()); }
  catch { if (active) setTimeout(connect, 3000); return; }

  ws.onopen = () => { retries = 0; setStatus('waiting', 'Waiting...'); };

  ws.onmessage = async ({ data }) => {
    let m; try { m = JSON.parse(data); } catch { return; }

    if (m.type === 'waiting') showOverlay('Waiting for a stranger...');

    if (m.type === 'matched') {
      roomId = m.room; myRole = m.role; metCount++;
      updateCounters(); hideOverlay();
      setStatus('connected', 'Connected');
      sysMsg('Connected! Say hello 👋');
      document.getElementById('nameTag').classList.add('visible');
      startTimer(); setInfo('Connected', null, 'Connecting...');
      await startCall();
    }

    if (m.type === 'offer')  { await onOffer(m); }
    if (m.type === 'answer' && pc) await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
    if (m.type === 'ice'    && pc) { try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {} }
    if (m.type === 'chat')   addMsg(m.text, 'them');

    if (m.type === 'peer_disconnected') {
      sysMsg('Stranger disconnected.');
      setStatus('waiting', 'Disconnected');
      document.getElementById('nameTag').classList.remove('visible');
      document.getElementById('remote').srcObject = null;
      stopTimer(); if (pc) { pc.close(); pc = null; }
      setInfo('Stranger left', null, '—');
      if (active) setTimeout(() => { sysMsg('Finding next...'); connect(); }, 1500);
    }
  };

  ws.onerror = () => { if (active) toast('Connection error, retrying...'); };
  ws.onclose = () => {
    if (active) { retries++; setTimeout(() => { if (active) connect(); }, Math.min(retries*1000,5000)); }
  };
}

// ── WEBRTC ──────────────────────────────────────────────────────
async function makePC() {
  if (pc) { pc.close(); pc = null; }
  pc = new RTCPeerConnection(ICE);
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  pc.ontrack = e => {
    const v = document.getElementById('remote');
    v.srcObject = e.streams[0];
    v.play().catch(() => {});
  };

  pc.onicecandidate = e => {
    if (e.candidate) send({ type:'ice', candidate:e.candidate, room:roomId });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') { setInfo(null, null, 'Connected ✓'); toast('Video connected!'); }
    if (s === 'failed' && active) setTimeout(connect, 1500);
  };
}

async function startCall() {
  await makePC();
  if (myRole === 'caller') {
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);
    send({ type:'offer', sdp:offer, room:roomId });
  }
}

async function onOffer(m) {
  await makePC();
  await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  send({ type:'answer', sdp:ans, room:roomId });
}

function hangup() {
  if (pc) { pc.close(); pc = null; }
  roomId = null; myRole = null;
  document.getElementById('remote').srcObject = null;
  document.getElementById('nameTag').classList.remove('visible');
  stopTimer(); showOverlay('Looking for someone...');
}

function send(m) { if (ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(m)); }

// ── CAMERA FLIP ──────────────────────────────────────────────────
async function flipCamera() {
  usingFrontCam = !usingFrontCam;
  toast(usingFrontCam ? 'Front camera' : 'Back camera');
  await startCamera(usingFrontCam);
}

// ── CHAT ────────────────────────────────────────────────────────
function sendChat()  { _doSend(document.getElementById('chatIn')); }
function sendMChat() { _doSend(document.getElementById('mChatIn')); }

function _doSend(el) {
  const txt = el.value.trim();
  if (!txt) return;
  if (!roomId) { toast('Connect to someone first!'); return; }
  send({ type:'chat', text:txt, room:roomId });
  addMsg(txt, 'me');
  el.value = ''; el.style.height = 'auto';
}

function addMsg(text, who) {
  ['msgs','mmsgs'].forEach(id => {
    const box = document.getElementById(id); if (!box) return;
    const d = document.createElement('div');
    d.className = `msg ${who}`; d.textContent = text;
    box.appendChild(d); box.scrollTop = box.scrollHeight;
  });
  if (who === 'them') toast('New message from stranger!');
}

function sysMsg(text) {
  ['msgs','mmsgs'].forEach(id => {
    const box = document.getElementById(id); if (!box) return;
    const d = document.createElement('div');
    d.className = 'msg sys'; d.textContent = text;
    box.appendChild(d); box.scrollTop = box.scrollHeight;
  });
}

function handleKey(e)  { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();} }
function handleMKey(e) { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMChat();} }
function resize(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,100)+'px'; }

// ── MEDIA TOGGLES ────────────────────────────────────────────────
function toggleMic() {
  if (!stream) return;
  micOn = !micOn;
  stream.getAudioTracks().forEach(t => t.enabled = micOn);
  const btn = document.getElementById('micBtn');
  const ico = document.getElementById('micIco');
  if (micOn) {
    btn.classList.remove('muted-state'); btn.classList.add('ghost');
    ico.innerHTML = '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    toast('Mic on');
  } else {
    btn.classList.remove('ghost'); btn.classList.add('muted-state');
    ico.innerHTML = '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>';
    toast('Mic muted');
  }
}

function toggleCam() {
  if (!stream) return; camOn = !camOn;
  stream.getVideoTracks().forEach(t => t.enabled = camOn);
  const btn = document.getElementById('camBtn');
  if (camOn) { btn.classList.remove('muted-state'); btn.classList.add('ghost'); toast('Camera on'); }
  else        { btn.classList.remove('ghost'); btn.classList.add('muted-state'); toast('Camera off'); }
}

function goFullscreen() {
  const el = document.querySelector('.video-wrap');
  if (!document.fullscreenElement) el.requestFullscreen().catch(()=>toast('Fullscreen not supported'));
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

// ── TABS ─────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.side-panel .tab').forEach((t,i)=>
    t.classList.toggle('active',(i===0&&name==='chat')||(i===1&&name==='opts')));
  ['pane-chat','pane-opts'].forEach(id=>
    document.getElementById(id).classList.toggle('active',id===`pane-${name}`));
}
function switchMobileTab(name) {
  document.querySelectorAll('.mobile-drawer .tab').forEach((t,i)=>
    t.classList.toggle('active',(i===0&&name==='chat')||(i===1&&name==='opts')));
  ['mpane-chat','mpane-opts'].forEach(id=>
    document.getElementById(id).classList.toggle('active',id===`mpane-${name}`));
}

// ── DRAWER ───────────────────────────────────────────────────────
function toggleDrawer() {
  const open = document.getElementById('drawer').classList.toggle('open');
  document.getElementById('backdrop').style.display = open ? 'block' : 'none';
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('backdrop').style.display = 'none';
}

// ── TIMER ────────────────────────────────────────────────────────
function startTimer() {
  timerStart = Date.now(); stopTimer();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now()-timerStart)/1000);
    const t = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    ['timerDisplay','iDur','miDur'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=t;});
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  const e = document.getElementById('timerDisplay'); if (e) e.textContent='00:00';
}

// ── STATUS / INFO ─────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot';
  if (type==='connected') dot.classList.add('connected');
  if (type==='waiting')   dot.classList.add('waiting');
  document.getElementById('statusText').textContent = text;
}
function setInfo(status, duration, conn) {
  if (status!=null)   { ['iStatus','miStatus'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=status;}); }
  if (duration!=null) { const e=document.getElementById('iDur');if(e)e.textContent=duration; }
  if (conn!=null)     { const e=document.getElementById('iConn');if(e)e.textContent=conn; }
}
function updateCounters() {
  ['iCount','miCount'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=metCount;});
}

// ── OVERLAY ──────────────────────────────────────────────────────
function showOverlay(msg) {
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('overlayMsg').textContent = msg;
}
function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }

// ── REPORT / BLOCK ────────────────────────────────────────────────
function openReport()  { if (!roomId){toast('No active session');return;} document.getElementById('reportModal').classList.add('open'); }
function closeReport() { document.getElementById('reportModal').classList.remove('open'); }
function submitReport() {
  const reason = document.getElementById('reportReason').value;
  if (!reason) { toast('Select a reason first'); return; }
  fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({room:roomId,reason,details:document.getElementById('reportDetails').value})
  }).catch(()=>{});
  closeReport(); toast('Reported. Skipping...'); sysMsg('You reported this user.');
  setTimeout(nextMatch, 800);
}
function blockUser() {
  if (!roomId){toast('No active session');return;}
  toast('Blocked. Skipping...'); sysMsg('You blocked this user.');
  setTimeout(nextMatch, 800);
}

// ── TOAST — always above buttons ──────────────────────────────────
let toastT;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2500);
}
