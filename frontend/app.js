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

// Camera device tracking (for reliable flip on mobile)
let videoDevices = [];           // populated after first getUserMedia permission grant
let currentVideoDeviceId = null;

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
  document.getElementById('setupScreen').classList.remove('hidden');
  renderInterestGrid();
  initAgeGate();
  await startCamera(true);
  // After permission is granted, labels become available — refresh the list
  await refreshVideoDevices();
  detectCountry();
  pollOnlineCount();
  setInterval(pollOnlineCount, 15000);
  console.log('[NexTalk] boot complete');
});

function initAgeGate() {
  const cb = document.getElementById('ageConfirm');
  const btn = document.getElementById('setupStart');
  if (!cb || !btn) return;
  if (localStorage.getItem('nextalk_age_ok') === '1') {
    cb.checked = true;
  }
  const sync = () => {
    btn.disabled = !cb.checked;
    if (cb.checked) localStorage.setItem('nextalk_age_ok', '1');
    else            localStorage.removeItem('nextalk_age_ok');
  };
  cb.addEventListener('change', sync);
  sync();
}

function initClientId() {
  clientId = localStorage.getItem('nextalk_cid');
  if (!clientId) {
    clientId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('nextalk_cid', clientId);
  }
}

async function detectCountry() {
  // Try ipapi.co first
  try {
    const r = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j.country_code) {
        myCountry.code = j.country_code.toUpperCase();
        myCountry.name = j.country_name || 'Unknown';
        myCountry.flag = codeToFlag(myCountry.code);
        console.log('[NexTalk] country (ipapi):', myCountry);
        updateSetupCountryUI();
        return;
      }
    }
  } catch (e) {
    console.warn('[NexTalk] ipapi.co failed:', e);
  }

  // Fallback to ipwho.is
  try {
    const r = await fetch('https://ipwho.is/', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j.success && j.country_code) {
        myCountry.code = j.country_code.toUpperCase();
        myCountry.name = j.country || 'Unknown';
        myCountry.flag = codeToFlag(myCountry.code);
        console.log('[NexTalk] country (ipwho):', myCountry);
        updateSetupCountryUI();
        return;
      }
    }
  } catch (e) {
    console.warn('[NexTalk] ipwho.is failed:', e);
  }

  // Last resort: try timezone-based detection
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const tzMap = {
      'Asia/Kolkata': ['IN', 'India'], 'Asia/Calcutta': ['IN', 'India'],
      'Asia/Tokyo': ['JP', 'Japan'], 'Asia/Shanghai': ['CN', 'China'],
      'America/New_York': ['US', 'United States'], 'America/Los_Angeles': ['US', 'United States'],
      'America/Chicago': ['US', 'United States'], 'America/Denver': ['US', 'United States'],
      'Europe/London': ['GB', 'United Kingdom'], 'Europe/Paris': ['FR', 'France'],
      'Europe/Berlin': ['DE', 'Germany'], 'Europe/Madrid': ['ES', 'Spain'],
      'Australia/Sydney': ['AU', 'Australia'], 'America/Toronto': ['CA', 'Canada'],
      'America/Sao_Paulo': ['BR', 'Brazil'], 'Asia/Dubai': ['AE', 'UAE'],
      'Asia/Singapore': ['SG', 'Singapore'], 'Asia/Seoul': ['KR', 'South Korea'],
    };
    if (tzMap[tz]) {
      myCountry.code = tzMap[tz][0];
      myCountry.name = tzMap[tz][1];
      myCountry.flag = codeToFlag(myCountry.code);
      console.log('[NexTalk] country (timezone):', myCountry);
      updateSetupCountryUI();
      return;
    }
  } catch {}

  // Give up gracefully
  myCountry = { code: '', name: 'Earth', flag: '🌍' };
  console.warn('[NexTalk] country detection failed entirely');
  updateSetupCountryUI();
}

function updateSetupCountryUI() {
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
  const cb = document.getElementById('ageConfirm');
  if (!cb || !cb.checked) {
    toast('Please confirm you are 18 or older'); return;
  }
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
// Enumerate cameras AFTER getting permission, then we can use deviceId
// for reliable front/back switching on Android (where facingMode is unreliable).
async function refreshVideoDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(d => d.kind === 'videoinput');
    console.log('[NexTalk] cameras found:', videoDevices.length,
      videoDevices.map(d => d.label || '(no label)').join(' | '));
  } catch (e) {
    console.warn('[NexTalk] enumerateDevices failed:', e);
    videoDevices = [];
  }
}

// Find best deviceId for a given facing direction.
function pickCameraDeviceId(wantFront) {
  if (!videoDevices.length) return null;
  if (videoDevices.length === 1) return videoDevices[0].deviceId;

  const frontKeys = ['front', 'user', 'self', 'face'];
  const backKeys  = ['back', 'environment', 'rear', 'world'];
  const keys     = wantFront ? frontKeys : backKeys;
  const antiKeys = wantFront ? backKeys : frontKeys;

  // 1. Label-based match (works once permission is granted on Android)
  let match = videoDevices.find(d => {
    const lbl = (d.label || '').toLowerCase();
    return keys.some(k => lbl.includes(k));
  });
  if (match) return match.deviceId;

  // 2. Anti-match: pick anything that isn't the wrong direction
  match = videoDevices.find(d => {
    const lbl = (d.label || '').toLowerCase();
    return !antiKeys.some(k => lbl.includes(k));
  });
  if (match) return match.deviceId;

  // 3. Last resort: pick a different camera than the currently active one
  match = videoDevices.find(d => d.deviceId !== currentVideoDeviceId);
  return match ? match.deviceId : videoDevices[0].deviceId;
}

function buildVideoConstraint(front) {
  const deviceId = pickCameraDeviceId(front);
  if (deviceId) {
    return {
      deviceId: { exact: deviceId },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };
  }
  return {
    facingMode: front ? 'user' : 'environment',
    width: { ideal: 1280 },
    height: { ideal: 720 }
  };
}

async function startCamera(front) {
  try {
    const isFlip = !!stream && !!stream.getAudioTracks().length;

    // CRITICAL: stop the old video track BEFORE asking for a new camera.
    // Android only allows one camera open at a time — if the front camera is
    // still active, requesting the back camera fails or returns the same camera.
    if (isFlip) {
      const oldVideoTrack = stream.getVideoTracks()[0];
      if (oldVideoTrack) {
        try { oldVideoTrack.stop(); } catch {}
        stream.removeTrack(oldVideoTrack);
      }
    }

    let newVideoStream;
    try {
      newVideoStream = await navigator.mediaDevices.getUserMedia({
        audio: isFlip ? false : true,
        video: buildVideoConstraint(front)
      });
    } catch (err) {
      console.warn('[NexTalk] primary getUserMedia failed:', err);
      try {
        newVideoStream = await navigator.mediaDevices.getUserMedia({
          audio: isFlip ? false : true,
          video: { facingMode: front ? 'user' : 'environment' }
        });
      } catch (err2) {
        console.warn('[NexTalk] facingMode fallback failed:', err2);
        newVideoStream = await navigator.mediaDevices.getUserMedia({
          audio: isFlip ? false : true,
          video: true
        });
      }
    }

    const newVideoTrack = newVideoStream.getVideoTracks()[0];
    const settings = newVideoTrack.getSettings ? newVideoTrack.getSettings() : {};
    currentVideoDeviceId = settings.deviceId || null;
    console.log('[NexTalk] active camera:', newVideoTrack.label || '(no label)',
      'facing:', settings.facingMode || '?', 'id:', (currentVideoDeviceId || '').slice(0, 8));

    if (isFlip) {
      stream.addTrack(newVideoTrack);
    } else {
      stream = newVideoStream;
    }

    // Refresh device list now that labels are available
    if (!videoDevices.length || !videoDevices.some(d => d.label)) {
      await refreshVideoDevices();
    }

    // Force re-bind of self-preview
    const localEl = document.getElementById('local');
    localEl.srcObject = null;
    localEl.srcObject = stream;
    localEl.play().catch(() => {});

    // Mirror only when the front camera is in use (natural for selfies, wrong for back cam)
    const previewEl = document.querySelector('.self-preview');
    if (previewEl) previewEl.classList.toggle('back-cam', !front);

    // Replace track on the peer connection
    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        try { await sender.replaceTrack(newVideoTrack); }
        catch (e) { console.warn('[NexTalk] replaceTrack failed:', e); }
      }
    }

    // Re-apply toggle state
    stream.getAudioTracks().forEach(t => t.enabled = micOn);
    newVideoTrack.enabled = camOn;

    setStatus('idle', 'Ready');
  } catch (e) {
    console.error('[NexTalk] camera error:', e);
    toast('Camera error: ' + (e.message || e.name || 'unknown'));
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

    if (m.type === 'banned') {
      active = false;
      intentionalClose = true;
      try { ws.close(); } catch {}
      ws = null;
      hangup();
      stopTimer();
      document.getElementById('startBtn').style.display = 'flex';
      document.getElementById('stopBtn').style.display  = 'none';
      document.getElementById('nextBtn').disabled = true;
      let until = '';
      if (m.expires_at) {
        const d = new Date(m.expires_at * 1000);
        until = ' until ' + d.toLocaleString();
      }
      showOverlay('Account temporarily blocked', (m.msg || 'Multiple reports') + until);
      setStatus('idle', 'Blocked');
      return;
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
  // Always show something on match, even if peer profile is missing entirely
  const info = peerInfo || {};
  console.log('[NexTalk] renderPeerInfo:', info);

  // Country — ALWAYS visible during a call, defaults to Earth
  const code = (info.country_code || '').toUpperCase();
  const flag = code && code.length === 2 ? codeToFlag(code) : '🌍';
  const cName = info.country_name || (code ? code : 'Earth');

  const peerCountryEl = document.getElementById('peerCountry');
  const peerFlagEl = document.getElementById('peerFlag');
  const peerNameEl = document.getElementById('peerCountryName');
  if (peerFlagEl) peerFlagEl.textContent = flag;
  if (peerNameEl) peerNameEl.textContent = cName;
  if (peerCountryEl) {
    peerCountryEl.classList.add('visible');
    // Force inline style too as a safety net
    peerCountryEl.style.opacity = '1';
    peerCountryEl.style.display = 'flex';
  }
  console.log('[NexTalk] flag set to:', flag, cName);

  // Rating
  const rcount = info.rating_count || 0;
  const ravg = info.rating_avg || 0;
  if (rcount > 0) {
    const v = document.getElementById('peerRatingValue');
    if (v) v.textContent = ravg.toFixed(1) + ` (${rcount})`;
    document.getElementById('peerRating').classList.add('visible');
    document.getElementById('peerRating').style.opacity = '1';
  } else {
    document.getElementById('peerRating').classList.remove('visible');
    document.getElementById('peerRating').style.opacity = '0';
  }

  // Interests
  const box = document.getElementById('peerInterests');
  if (box) {
    box.innerHTML = '';
    const mySet = new Set(myInterests.map(i => i.toLowerCase()));
    (info.interests || []).slice(0, 5).forEach(tag => {
      const el = document.createElement('span');
      el.className = 'peer-interest';
      if (mySet.has(tag.toLowerCase())) el.classList.add('shared');
      el.textContent = tag;
      box.appendChild(el);
    });
  }
}

function clearPeerInfo() {
  const c = document.getElementById('peerCountry');
  const r = document.getElementById('peerRating');
  if (c) { c.classList.remove('visible'); c.style.opacity = '0'; }
  if (r) { r.classList.remove('visible'); r.style.opacity = '0'; }
  const pi = document.getElementById('peerInterests');
  if (pi) pi.innerHTML = '';
  peerInfo = null;
}

// ─── RATING ──────────────────────────────────────────────────
let pendingRateTarget = null;
function maybeShowRating(targetId) {
  console.log('[NexTalk] maybeShowRating called with:', targetId);
  if (!targetId) {
    console.log('[NexTalk] no targetId — rating skipped');
    return;
  }
  // Don't show if the chat lasted less than 3 seconds (probably just opened+closed)
  if (timerStart && (Date.now() - timerStart) < 3000) {
    console.log('[NexTalk] chat too short — rating skipped');
    return;
  }
  pendingRateTarget = targetId;
  const el = document.getElementById('ratingPrompt');
  el.classList.add('show');
  console.log('[NexTalk] rating prompt shown for', targetId);
  // Auto-hide after 8s
  clearTimeout(window.__rateHideT);
  window.__rateHideT = setTimeout(() => el.classList.remove('show'), 8000);
}

function ratePeer(score) {
  console.log('[NexTalk] ratePeer:', score, 'target:', pendingRateTarget);
  if (!pendingRateTarget) { hideRating(); return; }
  fetch('/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_client_id: pendingRateTarget,
      rater_client_id: clientId,
      score: score,
    })
  }).then(r => r.json()).then(j => {
    console.log('[NexTalk] rate response:', j);
  }).catch(e => console.warn('[NexTalk] rate failed:', e));
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
let flipInProgress = false;
async function flipCamera() {
  if (flipInProgress) return;
  if (!stream) { toast('Camera not ready'); return; }
  flipInProgress = true;
  try {
    // Make sure we know what cameras exist (labels need permission)
    if (!videoDevices.length || !videoDevices.some(d => d.label)) {
      await refreshVideoDevices();
    }
    if (videoDevices.length < 2) {
      toast('Only one camera available');
      flipInProgress = false;
      return;
    }
    usingFrontCam = !usingFrontCam;
    toast(usingFrontCam ? 'Switching to front...' : 'Switching to back...');
    await startCamera(usingFrontCam);
    toast(usingFrontCam ? 'Front camera' : 'Back camera');
  } catch (e) {
    console.error('[NexTalk] flip failed:', e);
    toast('Flip failed: ' + (e.message || e.name));
    // Revert flag if it actually failed
    usingFrontCam = !usingFrontCam;
  } finally {
    flipInProgress = false;
  }
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
    body:JSON.stringify({
      room: roomId,
      reason,
      details: document.getElementById('reportDetails').value,
      rater_client_id: clientId,
    })
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
