// ─── CURATED INTERESTS ────────────────────────────────────────
const CURATED_INTERESTS = [
  "music", "gaming", "movies", "anime", "books", "art",
  "travel", "food", "sports", "fitness", "tech", "coding",
  "photography", "fashion", "memes", "philosophy", "science", "history",
  "languages", "cars", "pets", "dance", "writing", "design",
  "podcasts", "crypto", "startups", "psychology", "nature", "diy"
];

// ─── ICE CONFIG ───────────────────────────────────────────────
const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80",  username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
  ]
};

// ─── STATE ────────────────────────────────────────────────────
let ws, pc, stream;
let roomId = null, myRole = null;
let micOn = true, camOn = true;
let active = false;
let metCount = 0;
let timerStart = null, timerInterval = null;
let retries = 0;
let usingFrontCam = true;

let hasEverConnected = false;
let intentionalClose = false;
let waitingForPeer = false;

// Profile
let clientId = null;
let myCountry = { code: "", name: "Unknown", flag: "🌍" };
let myInterests = [];
let peerInfo = null;     // {client_id, country_code, country_name, interests, rating_avg, rating_count}
let lastPeerClientId = null; // for rating prompt after disconnect

// ─── BOOT ─────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  console.log('[NexTalk] booting...');
  initClientId();
  // Always show setup on every load (until user picks interests)
  document.getElementById('setupScreen').classList.remove('hidden');
  renderInterestGrid();
  await startCamera(true);
  detectCountry();   // run in background, don't block UI
  pollOnlineCount();
  setInterval(pollOnlineCount, 15000);
  console.log('[NexTalk] boot complete');
});

function initClientId() {
  clientId = localStorage.getItem('nextalk_cid');
  if (!clientId) {
    clientId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('nextalk_cid', clientId);
  }
}

async function detectCountry() {
  try {
    const r = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
    if (!r.ok) throw new Error('geoip failed');
    const j = await r.json();
    myCountry.code = (j.country_code || '').toUpperCase();
    myCountry.name = j.country_name || 'Unknown';
    myCountry.flag = codeToFlag(myCountry.code);
  } catch (e) {
    console.warn('[NexTalk] country detect failed:', e);
    myCountry = { code: '', name: 'Unknown', flag: '🌍' };
  }
  const flagEl = document.getElementById('setupFlag');
  const nameEl = document.getElementById('setupCountry');
  if (flagEl) flagEl.textContent = myCountry.flag;
  if (nameEl) nameEl.textContent = myCountry.name;
}

function codeToFlag(code) {
  if (!code || code.length !== 2) return '🌍';
  const A = 0x1F1E6;
  return String.fromCodePoint(
    A + (code.charCodeAt(0) - 65),
    A + (code.charCodeAt(1) - 65)
  );
}

function renderInterestGrid() {
  const grid = document.getElementById('interestGrid');
  grid.innerHTML = '';
  CURATED_INTERESTS.forEach(tag => {
    const el = document.createElement('div');
    el.className = 'interest-chip';
    el.textContent = tag;
    el.onclick = () => toggleInterest(el, tag);
    grid.appendChild(el);
  });
}

function toggleInterest(el, tag) {
  if (el.classList.contains('selected')) {
    el.classList.remove('selected');
    myInterests = myInterests.filter(i => i !== tag);
  } else {
    const customs = getCustomInterests();
    if (myInterests.length + customs.length >= 5) {
      toast('Max 5 interests'); return;
    }
    el.classList.add('selected');
    myInterests.push(tag);
  }
}

function getCustomInterests() {
  const raw = document.getElementById('customInterest').value || '';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s && s.length <= 25);
}

function finishSetup() {
  const customs = getCustomInterests();
  const all = [...new Set([...myInterests, ...customs])].slice(0, 5);
  myInterests = all;
  if (all.length === 0) {
    toast('Pick at least 1 interest'); return;
  }
  renderMyInterestsInOptions();
  document.getElementById('setupScreen').classList.add('hidden');
}

function renderMyInterestsInOptions() {
  const box = document.getElementById('myInterestsDisplay');
  if (!box) return;
  box.innerHTML = '';
  myInterests.forEach(i => {
    const el = document.createElement('span');
    el.className = 'my-interest-chip';
    el.textContent = i;
    box.appendChild(el);
  });
}

function editInterests() {
  // Re-show setup, restore current selection
  document.getElementById('setupScreen').classList.remove('hidden');
  document.querySelectorAll('.interest-chip').forEach(el => {
    el.classList.toggle('selected', myInterests.includes(el.textContent));
  });
  const customs = myInterests.filter(i => !CURATED_INTERESTS.includes(i));
  document.getElementById('customInterest').value = customs.join(', ');
}

// ─── CAMERA ───────────────────────────────────────────────────
// ─── CAMERA ───────────────────────────────────────────────────
// Called twice: once on boot (front=true, full audio+video), and on flip.
// We keep the audio track alive across flips so the call doesn't go silent.
async function startCamera(front) {
  try {
    const isFlip = !!stream && !!stream.getAudioTracks().length;
    let newVideoStream;
    try {
      newVideoStream = await navigator.mediaDevices.getUserMedia({
        audio: isFlip ? false : true,
        video: { facingMode: front ? 'user' : 'environment', width:{ideal:1280}, height:{ideal:720} }
      });
    } catch (err) {
      // Fallback: some Android browsers fail with exact facingMode constraint
      console.warn('[NexTalk] facingMode failed, retrying without:', err);
      newVideoStream = await navigator.mediaDevices.getUserMedia({
        audio: isFlip ? false : true,
        video: true
      });
    }

    const newVideoTrack = newVideoStream.getVideoTracks()[0];

    if (isFlip) {
      // Stop ONLY the old video track. Keep the audio track running.
      const oldVideoTrack = stream.getVideoTracks()[0];
      if (oldVideoTrack) {
        stream.removeTrack(oldVideoTrack);
        try { oldVideoTrack.stop(); } catch {}
      }
      stream.addTrack(newVideoTrack);
    } else {
      // First-time setup: assign the new stream (audio + video).
      stream = newVideoStream;
    }

    // Always refresh self-preview srcObject
    const localEl = document.getElementById('local');
    localEl.srcObject = stream;
    localEl.play().catch(() => {});

    // If we're in an active call, replace the video sender's track
    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && newVideoTrack) {
        try { await sender.replaceTrack(newVideoTrack); }
        catch (e) { console.warn('[NexTalk] replaceTrack failed:', e); }
      }
      // Re-apply camera-on/off state (replaceTrack resets enabled to true)
      newVideoTrack.enabled = camOn;
    }

    // Re-apply mic state too
    stream.getAudioTracks().forEach(t => t.enabled = micOn);

    setStatus('idle', 'Ready');
  } catch (e) {
    console.error('[NexTalk] camera error:', e);
    toast('Camera/mic denied — check permissions');
    setStatus('idle', 'No camera');
  }
}

const wsUrl = () => `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`;

// ─── SESSION ─────────────────────────────────────────────────
function startSession() {
  if (!stream) { toast('Camera not available'); return; }
  if (myInterests.length === 0) {
    document.getElementById('setupScreen').classList.remove('hidden');
    return;
  }
  active = true; retries = 0;
  hasEverConnected = false; intentionalClose = false;
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display  = 'flex';
  document.getElementById('nextBtn').disabled = false;
  connect();
}

function stopSession() {
  active = false; intentionalClose = true;
  // Capture peer for rating before clearing
  const ratePeerId = peerInfo && peerInfo.client_id;
  hangup();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  stopTimer();
  document.getElementById('startBtn').style.display = 'flex';
  document.getElementById('stopBtn').style.display  = 'none';
  document.getElementById('nextBtn').disabled = true;
  showOverlay('Click "Start" to find someone', '');
  setStatus('idle', 'Disconnected');
  sysMsg('Session ended.');
  setInfo('Idle', '—');
  waitingForPeer = false;
  if (ratePeerId) maybeShowRating(ratePeerId);
}

function nextMatch() {
  if (!active) return;
  const ratePeerId = peerInfo && peerInfo.client_id;
  hangup();
  sysMsg('Finding next stranger...');
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'requeue' });
    showOverlay('Looking for someone...', 'Matching interests...');
    setStatus('waiting', 'Searching...');
  } else {
    connect();
  }
  if (ratePeerId) maybeShowRating(ratePeerId);
}

// ─── CONNECT ─────────────────────────────────────────────────
function connect() {
  if (ws) { intentionalClose = true; try { ws.close(); } catch {} ws = null; }
  intentionalClose = false;
  waitingForPeer = false;

  if (!hasEverConnected) {
    showOverlay('Connecting to server...', '');
    setStatus('waiting', 'Connecting...');
  } else {
    showOverlay('Looking for someone...', 'Matching interests...');
    setStatus('waiting', 'Searching...');
  }

  try { ws = new WebSocket(wsUrl()); }
  catch { if (active) setTimeout(connect, 3000); return; }

  ws.onopen = () => { retries = 0; hasEverConnected = true; };

  ws.onmessage = async ({ data }) => {
    let m; try { m = JSON.parse(data); } catch { return; }

    if (m.type === 'ready') {
      // Server is ready; send our profile to enter matchmaking
      send({
        type: 'connect',
        client_id: clientId,
        interests: myInterests,
        country_code: myCountry.code,
        country_name: myCountry.name,
      });
    }

    if (m.type === 'waiting') {
      waitingForPeer = true;
      const onlineN = m.online || 1;
      const sub = onlineN <= 1
        ? "You're the only one here. We'll match you as soon as someone joins."
        : `${onlineN} people online · finding someone with similar interests...`;
      showOverlay('Waiting for someone to join...', sub);
      setStatus('waiting', 'Waiting for match');
      if (m.online) updateOnlineCount(m.online);
    }

    if (m.type === 'matched') {
      waitingForPeer = false;
      roomId = m.room; myRole = m.role; metCount++;
      peerInfo = m.peer || null;
      lastPeerClientId = peerInfo ? peerInfo.client_id : null;
      updateCounters(); hideOverlay();
      setStatus('connected', 'Connected');
      sysMsg('Connected! Say hello 👋');
      renderPeerInfo();
      startTimer(); setInfo('Connected', null);
      document.getElementById('timerTag').style.display = 'flex';
      await startCall();
    }

    if (m.type === 'offer')  { await onOffer(m); }
    if (m.type === 'answer' && pc) await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
    if (m.type === 'ice'    && pc) { try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {} }
    if (m.type === 'chat')   addMsg(m.text, 'them');

    if (m.type === 'peer_disconnected') {
      const ratePeerId = peerInfo && peerInfo.client_id;
      sysMsg('Stranger disconnected.');
      setStatus('waiting', 'Searching...');
      clearPeerInfo();
      document.getElementById('remote').srcObject = null;
      stopTimer(); document.getElementById('timerTag').style.display = 'none';
      if (pc) { pc.close(); pc = null; }
      roomId = null; myRole = null;
      setInfo('Stranger left', null);
      if (active && ws && ws.readyState === WebSocket.OPEN) {
        showOverlay('Looking for someone...', 'Finding your next match...');
        setTimeout(() => {
          if (active && ws && ws.readyState === WebSocket.OPEN) send({ type: 'requeue' });
          else if (active) connect();
        }, 800);
      } else if (active) {
        setTimeout(connect, 800);
      }
      if (ratePeerId) maybeShowRating(ratePeerId);
    }
  };

  ws.onerror = () => { /* silent */ };

  ws.onclose = () => {
    if (intentionalClose) return;
    if (!active) return;
    waitingForPeer = false;
    if (!hasEverConnected) {
      retries++;
      const delay = Math.min(2000 + retries * 1000, 8000);
      if (retries === 3) showOverlay('Server is waking up, please wait...', 'Free hosting takes ~50s to spin up');
      else if (retries >= 8) {
        showOverlay("Can't reach server. Retrying...", '');
        setStatus('waiting', 'Server unreachable');
      }
      setTimeout(() => { if (active) connect(); }, delay);
      return;
    }
    retries++;
    setStatus('waiting', 'Reconnecting...');
    showOverlay('Reconnecting...', '');
    setTimeout(() => { if (active) connect(); }, Math.min(retries * 1000, 5000));
  };
}

// ─── PEER INFO RENDERING ─────────────────────────────────────
function renderPeerInfo() {
  if (!peerInfo) return;
  // Country
  const flag = codeToFlag(peerInfo.country_code || '');
  const cName = peerInfo.country_name || 'Unknown';
  document.getElementById('peerFlag').textContent = flag;
  document.getElementById('peerCountryName').textContent = cName;
  document.getElementById('peerCountry').classList.add('visible');

  // Rating (only show if they have at least 1 rating)
  if (peerInfo.rating_count > 0) {
    document.getElementById('peerRatingValue').textContent =
      peerInfo.rating_avg.toFixed(1) + ` (${peerInfo.rating_count})`;
    document.getElementById('peerRating').classList.add('visible');
  } else {
    document.getElementById('peerRating').classList.remove('visible');
  }

  // Interests
  const box = document.getElementById('peerInterests');
  box.innerHTML = '';
  const mySet = new Set(myInterests.map(i => i.toLowerCase()));
  (peerInfo.interests || []).slice(0, 5).forEach(tag => {
    const el = document.createElement('span');
    el.className = 'peer-interest';
    if (mySet.has(tag.toLowerCase())) el.classList.add('shared');
    el.textContent = tag;
    box.appendChild(el);
  });
}

function clearPeerInfo() {
  document.getElementById('peerCountry').classList.remove('visible');
  document.getElementById('peerRating').classList.remove('visible');
  document.getElementById('peerInterests').innerHTML = '';
  peerInfo = null;
}

// ─── RATING ──────────────────────────────────────────────────
let pendingRateTarget = null;
function maybeShowRating(targetId) {
  if (!targetId) return;
  // Only show if we actually had a real chat (timer ran)
  pendingRateTarget = targetId;
  const el = document.getElementById('ratingPrompt');
  el.classList.add('show');
  // Auto-hide after 5s
  clearTimeout(window.__rateHideT);
  window.__rateHideT = setTimeout(() => el.classList.remove('show'), 5000);
}

function ratePeer(score) {
  if (!pendingRateTarget) { hideRating(); return; }
  fetch('/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_client_id: pendingRateTarget,
      rater_client_id: clientId,
      score: score,
    })
  }).catch(() => {});
  toast(score === 1 ? 'Thanks for your feedback! 👍' : 'Got it, thanks 👎');
  hideRating();
}

function hideRating() {
  pendingRateTarget = null;
  document.getElementById('ratingPrompt').classList.remove('show');
}

// ─── ONLINE COUNT POLL ───────────────────────────────────────
async function pollOnlineCount() {
  try {
    const r = await fetch('/stats', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    updateOnlineCount(j.online);
  } catch {}
}
function updateOnlineCount(n) {
  document.getElementById('onlineCount').textContent = n;
}

// ─── WEBRTC ──────────────────────────────────────────────────
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
    if (s === 'connected') { setInfo(null, null); toast('Video connected!'); }
    if (s === 'failed' && active) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        send({ type: 'requeue' });
        showOverlay('Looking for someone...', '');
      } else setTimeout(connect, 1500);
    }
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
  clearPeerInfo();
  stopTimer();
  document.getElementById('timerTag').style.display = 'none';
  showOverlay('Looking for someone...', '');
}

function send(m) { if (ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(m)); }

// ─── CAMERA FLIP ─────────────────────────────────────────────
async function flipCamera() {
  usingFrontCam = !usingFrontCam;
  toast(usingFrontCam ? 'Front camera' : 'Back camera');
  await startCamera(usingFrontCam);
}

// ─── CHAT ───────────────────────────────────────────────────
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
  if (who === 'them') toast('New message!');
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

// ─── MEDIA TOGGLES ───────────────────────────────────────────
function toggleMic() {
  if (!stream) return; micOn = !micOn;
  stream.getAudioTracks().forEach(t => t.enabled = micOn);
  const btn = document.getElementById('micBtn');
  btn.classList.toggle('muted-state', !micOn);
  toast(micOn ? 'Mic on' : 'Mic muted');
}
function toggleCam() {
  if (!stream) return; camOn = !camOn;
  stream.getVideoTracks().forEach(t => t.enabled = camOn);
  const btn = document.getElementById('camBtn');
  btn.classList.toggle('muted-state', !camOn);
  toast(camOn ? 'Camera on' : 'Camera off');
}
function goFullscreen() {
  const el = document.querySelector('.video-wrap');
  if (!document.fullscreenElement) el.requestFullscreen().catch(()=>toast('Fullscreen not supported'));
  else document.exitFullscreen();
}

// ─── TABS ────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.side-panel .tab').forEach((t,i)=>
    t.classList.toggle('active',(i===0&&name==='chat')||(i===1&&name==='opts')));
  ['pane-chat','pane-opts'].forEach(id=>
    document.getElementById(id).classList.toggle('active',id===`pane-${name}`));
}
function switchMobileTab(name) {
  document.querySelectorAll('.drawer .tab').forEach((t,i)=>
    t.classList.toggle('active',(i===0&&name==='chat')||(i===1&&name==='opts')));
  ['mpane-chat','mpane-opts'].forEach(id=>
    document.getElementById(id).classList.toggle('active',id===`mpane-${name}`));
}

// ─── DRAWER ──────────────────────────────────────────────────
function toggleDrawer() {
  const open = document.getElementById('drawer').classList.toggle('open');
  document.getElementById('backdrop').style.display = open ? 'block' : 'none';
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('backdrop').style.display = 'none';
}

// ─── TIMER ───────────────────────────────────────────────────
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

// ─── STATUS / INFO ───────────────────────────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot';
  if (type==='connected') dot.classList.add('connected');
  if (type==='waiting')   dot.classList.add('waiting');
  document.getElementById('statusText').textContent = text;
}
function setInfo(status, duration) {
  if (status!=null)   { ['iStatus','miStatus'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=status;}); }
  if (duration!=null) { const e=document.getElementById('iDur');if(e)e.textContent=duration; }
}
function updateCounters() {
  ['iCount','iCount2','miCount'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=metCount;});
}

// ─── OVERLAY ─────────────────────────────────────────────────
function showOverlay(msg, sub) {
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('overlayMsg').textContent = msg;
  document.getElementById('overlaySub').textContent = sub || '';
}
function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }

// ─── REPORT / BLOCK ──────────────────────────────────────────
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

// ─── TOAST ───────────────────────────────────────────────────
let toastT;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2500);
}
