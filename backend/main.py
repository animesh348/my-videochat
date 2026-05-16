from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel, constr
from datetime import datetime, timezone
from collections import defaultdict, deque
from pathlib import Path
import asyncio, base64, hashlib, hmac, json, logging, os, secrets, time
import urllib.parse, urllib.request

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# ── CONFIG ───────────────────────────────────────────────────────
MAX_PICKY_WAIT_SEC   = 10.0
MAX_MSG_BYTES        = 16 * 1024     # max bytes for a single WS frame
MAX_CHAT_LEN         = 2000          # max chars per chat message
MAX_MSGS_PER_10S     = 60            # per-connection rate limit
RATE_GRANT_TTL_SEC   = 60 * 60       # how long a rating right stays valid after match
REPORTS_FILE         = Path("reports.jsonl")

# Per-IP gates (defeats trivial spam from one machine)
IP_MAX_CONCURRENT    = 5             # simultaneous WS connections per IP
IP_MAX_PER_MIN       = 30            # new WS connects per IP per minute

# Auto-moderation
REPORT_BAN_THRESHOLD = 3             # reports within window → temp ban
REPORT_WINDOW_SEC    = 24 * 60 * 60  # 24h sliding window
BAN_DURATION_SEC     = 24 * 60 * 60  # 24h ban
BANS_FILE            = Path("bans.jsonl")

# Cloudflare Turnstile (CAPTCHA). Defaults are Cloudflare's always-pass test keys —
# fine for dev, NOT for production. In prod, set both env vars from your dashboard:
#   TURNSTILE_SITE_KEY  — public site key (visible in frontend)
#   TURNSTILE_SECRET    — server-side secret
# To disable CAPTCHA entirely (e.g. behind a private network), set TURNSTILE_REQUIRED=0.
TURNSTILE_SITE_KEY = os.getenv("TURNSTILE_SITE_KEY", "1x00000000000000000000AA")
TURNSTILE_SECRET   = os.getenv("TURNSTILE_SECRET",   "1x0000000000000000000000000000000AA")
TURNSTILE_REQUIRED = os.getenv("TURNSTILE_REQUIRED", "1") not in ("0", "false", "False", "")
TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

# HMAC-signed session ticket so verified clients don't need to re-CAPTCHA every
# reconnect. SESSION_SECRET defaults to a fresh per-process value (existing
# tickets become invalid on restart). Set it via env to persist across restarts.
SESSION_SECRET   = os.getenv("SESSION_SECRET") or secrets.token_hex(32)
SESSION_TTL_SEC  = 4 * 60 * 60

# Message types we accept at all
ALLOWED_TYPES = {"connect", "requeue", "offer", "answer", "ice", "chat", "captcha"}

# ── STATE ────────────────────────────────────────────────────────
# Each entry: {"ws": WebSocket, "profile": {...}, "queued_at": float}
waiting_pool: list[dict] = []
rooms: dict[str, list[WebSocket]] = {}

# client_id -> {"sum": float, "count": int, "avg": float}
ratings: dict[str, dict] = defaultdict(lambda: {"sum": 0.0, "count": 0, "avg": 0.0})

# ws -> profile (so we can look up after match)
ws_profile: dict[WebSocket, dict] = {}

# Rate-this-peer grants: rater_cid -> {target_cid: expires_at_unix}
# Populated on match, consumed by /rate, pruned lazily.
rate_grants: dict[str, dict[str, float]] = defaultdict(dict)

# Per-ws message timestamps for the rate limiter
ws_msg_times: dict[WebSocket, deque] = {}

# Per-IP throttle state
ip_active: dict[str, int] = defaultdict(int)            # currently open WS per IP
ip_recent: dict[str, deque] = defaultdict(deque)        # recent connect timestamps per IP

# Room → (cid_a, cid_b) so we can identify the report target
room_pairs: dict[str, tuple[str, str]] = {}

# Sliding-window report counts: target_cid -> deque[ts]
report_counts: dict[str, deque] = defaultdict(deque)

# Active bans: cid -> expires_at (unix)
banned_cids: dict[str, float] = {}

# WS connections that have passed CAPTCHA this session
verified_ws: set[WebSocket] = set()


# ── REPORT ENDPOINT ─────────────────────────────────────────────
class ReportPayload(BaseModel):
    room: constr(strip_whitespace=True, max_length=64) = ""
    reason: constr(strip_whitespace=True, max_length=40)
    details: constr(max_length=500) = ""
    rater_client_id: constr(strip_whitespace=True, max_length=64) = ""

@app.post("/report")
async def submit_report(payload: ReportPayload):
    # Figure out who is being reported via the room pairing.
    target_cid = ""
    pair = room_pairs.get(payload.room)
    if pair and payload.rater_client_id in pair:
        target_cid = pair[0] if pair[1] == payload.rater_client_id else pair[1]

    entry = {
        "room": payload.room,
        "reason": payload.reason,
        "details": payload.details,
        "rater_client_id": payload.rater_client_id,
        "target_client_id": target_cid,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        with REPORTS_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.error(f"Could not persist report: {e}")
    logger.warning(f"REPORT: {entry}")

    banned = record_report_against(target_cid, payload.reason) if target_cid else False
    return JSONResponse({"status": "received", "target_banned": banned})


# ── RATING ENDPOINT ─────────────────────────────────────────────
class RatePayload(BaseModel):
    target_client_id: constr(strip_whitespace=True, min_length=1, max_length=64)
    rater_client_id:  constr(strip_whitespace=True, min_length=1, max_length=64)
    score: int

@app.post("/rate")
async def submit_rating(payload: RatePayload):
    if payload.score not in (1, -1):
        return JSONResponse({"status": "error", "msg": "invalid score"}, status_code=400)
    if payload.target_client_id == payload.rater_client_id:
        return JSONResponse({"status": "error", "msg": "cannot self-rate"}, status_code=400)

    # Must have a live grant — i.e. the two clients were paired recently.
    now = time.time()
    grants = rate_grants.get(payload.rater_client_id, {})
    exp = grants.get(payload.target_client_id, 0)
    if not exp or exp < now:
        grants.pop(payload.target_client_id, None)
        return JSONResponse(
            {"status": "error", "msg": "no recent match with this user"},
            status_code=403,
        )
    # Consume — one rating per pairing.
    grants.pop(payload.target_client_id, None)
    if not grants:
        rate_grants.pop(payload.rater_client_id, None)

    points = 5.0 if payload.score == 1 else 1.0
    r = ratings[payload.target_client_id]
    r["sum"] += points
    r["count"] += 1
    r["avg"] = round(r["sum"] / r["count"], 2)
    logger.info(f"RATING: {payload.target_client_id} -> {r['avg']} ({r['count']} ratings)")
    return JSONResponse({"status": "received", "avg": r["avg"], "count": r["count"]})


# ── STATS ENDPOINT ───────────────────────────────────────────────
@app.get("/stats")
async def get_stats():
    return {
        "online":  len(ws_profile),
        "waiting": len(waiting_pool),
        "in_chat": len(rooms) * 2,
    }


# ── CONFIG ENDPOINT (public, used by frontend to render CAPTCHA) ──
@app.get("/config")
async def get_config():
    return {
        "turnstile_site_key": TURNSTILE_SITE_KEY,
        "turnstile_required": TURNSTILE_REQUIRED,
    }


# ── CAPTCHA / SESSION TICKETS ────────────────────────────────────
def make_session_token() -> str:
    """Issue an HMAC-signed ticket that proves this browser passed CAPTCHA."""
    exp = int(time.time()) + SESSION_TTL_SEC
    nonce = secrets.token_hex(8)
    payload = f"{nonce}.{exp}"
    sig = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
    return f"{payload}.{sig_b64}"


def verify_session_token(token: str) -> bool:
    if not token or len(token) > 200:
        return False
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return False
        nonce, exp_str, sig_b64 = parts
        if int(exp_str) < time.time():
            return False
        payload = f"{nonce}.{exp_str}"
        expected = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
        expected_b64 = base64.urlsafe_b64encode(expected).rstrip(b"=").decode()
        return hmac.compare_digest(sig_b64, expected_b64)
    except Exception:
        return False


async def verify_turnstile(token: str, ip: str) -> bool:
    """Verify a Turnstile token via Cloudflare's siteverify API.

    Done in a thread because we don't want a third-party HTTP dep just for this.
    """
    if not TURNSTILE_REQUIRED:
        return True
    if not token or len(token) > 2048:
        return False

    def _verify() -> bool:
        try:
            body = urllib.parse.urlencode({
                "secret":   TURNSTILE_SECRET,
                "response": token,
                "remoteip": ip,
            }).encode()
            req = urllib.request.Request(TURNSTILE_VERIFY_URL, data=body)
            with urllib.request.urlopen(req, timeout=5) as resp:
                return bool(json.loads(resp.read()).get("success", False))
        except Exception as e:
            logger.error(f"Turnstile verify error: {e}")
            return False

    return await asyncio.get_event_loop().run_in_executor(None, _verify)


# ── MATCHING HELPERS ─────────────────────────────────────────────
def score_match(my_profile: dict, their_profile: dict) -> int:
    """Higher = better match. Based on interest overlap + similar rating tier."""
    my_interests = set(i.lower().strip() for i in my_profile.get("interests", []))
    their_interests = set(i.lower().strip() for i in their_profile.get("interests", []))
    overlap = len(my_interests & their_interests)
    my_avg = my_profile.get("rating_avg", 0)
    their_avg = their_profile.get("rating_avg", 0)
    rating_bonus = 1 if (my_avg > 0 and their_avg > 0 and abs(my_avg - their_avg) < 1.0) else 0
    return overlap * 10 + rating_bonus


def get_rating_for(client_id: str) -> dict:
    if client_id in ratings and ratings[client_id]["count"] > 0:
        r = ratings[client_id]
        return {"avg": r["avg"], "count": r["count"]}
    return {"avg": 0, "count": 0}


def public_profile(profile: dict) -> dict:
    """What we expose to the peer about a user."""
    cid = profile.get("client_id", "")
    rating = get_rating_for(cid)
    return {
        "interests":     profile.get("interests", []),
        "country_code":  profile.get("country_code", ""),
        "country_name":  profile.get("country_name", ""),
        "rating_avg":    rating["avg"],
        "rating_count":  rating["count"],
        "client_id":     cid,
    }


async def try_match(ws: WebSocket, profile: dict):
    """
    Match ws with the best available peer, or queue them.
    """
    now = time.time()
    my_interests = set(i.lower().strip() for i in profile.get("interests", []))

    best_idx = -1
    best_score = -1
    for i, entry in enumerate(waiting_pool):
        if entry["ws"] is ws:
            continue
        s = score_match(profile, entry["profile"])
        # Older waiters get a small time bonus to avoid starvation
        s += int((now - entry["queued_at"]) / 5)
        if s > best_score:
            best_score = s
            best_idx = i

    should_match = False
    if best_idx >= 0:
        if best_score >= 10:
            should_match = True
        elif best_score >= 0:
            partner_wait = now - waiting_pool[best_idx]["queued_at"]
            if partner_wait > MAX_PICKY_WAIT_SEC or not my_interests:
                should_match = True

    if should_match:
        partner_entry = waiting_pool.pop(best_idx)
        partner = partner_entry["ws"]
        partner_profile = partner_entry["profile"]

        room_id = secrets.token_urlsafe(12)
        try:
            rooms[room_id] = [partner, ws]

            my_cid    = profile.get("client_id", "")
            their_cid = partner_profile.get("client_id", "")
            room_pairs[room_id] = (my_cid, their_cid)

            # Grant each side the right to rate the other (expires in 1h)
            exp = now + RATE_GRANT_TTL_SEC
            if my_cid and their_cid:
                rate_grants[my_cid][their_cid] = exp
                rate_grants[their_cid][my_cid] = exp

            await partner.send_json({
                "type": "matched", "role": "caller",
                "room": room_id, "peer": public_profile(profile),
            })
            await ws.send_json({
                "type": "matched", "role": "callee",
                "room": room_id, "peer": public_profile(partner_profile),
            })
            logger.info(f"Matched room {room_id} (score={best_score})")
            return
        except Exception as e:
            logger.warning(f"Match send failed: {e}")
            rooms.pop(room_id, None)
            room_pairs.pop(room_id, None)

    if not any(e["ws"] is ws for e in waiting_pool):
        waiting_pool.append({"ws": ws, "profile": profile, "queued_at": now})

    try:
        await ws.send_json({"type": "waiting", "online": len(ws_profile)})
    except Exception:
        pass


def remove_from_pool(ws: WebSocket):
    global waiting_pool
    waiting_pool = [e for e in waiting_pool if e["ws"] is not ws]


def cleanup_room_for(ws: WebSocket):
    """Remove ws from any room and return the peer (or None)."""
    for rid, peers in list(rooms.items()):
        if ws in peers:
            peer = next((p for p in peers if p is not ws), None)
            del rooms[rid]
            room_pairs.pop(rid, None)
            logger.info(f"Closed room {rid}")
            return peer
    return None


def check_rate_limit(ws: WebSocket) -> bool:
    now = time.time()
    q = ws_msg_times.setdefault(ws, deque())
    while q and now - q[0] > 10.0:
        q.popleft()
    if len(q) >= MAX_MSGS_PER_10S:
        return False
    q.append(now)
    return True


def client_ip(ws: WebSocket) -> str:
    """Return the originating client IP, honoring a reverse-proxy X-Forwarded-For."""
    xff = ws.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    if ws.client and ws.client.host:
        return ws.client.host
    return "unknown"


def ip_admit(ip: str) -> bool:
    """True iff this IP may open a new connection right now."""
    now = time.time()
    q = ip_recent[ip]
    while q and now - q[0] > 60.0:
        q.popleft()
    if len(q) >= IP_MAX_PER_MIN:
        return False
    if ip_active[ip] >= IP_MAX_CONCURRENT:
        return False
    q.append(now)
    return True


def ip_release(ip: str) -> None:
    if ip_active[ip] > 0:
        ip_active[ip] -= 1
    if ip_active[ip] == 0:
        ip_active.pop(ip, None)


def is_banned(cid: str) -> bool:
    if not cid:
        return False
    exp = banned_cids.get(cid)
    if exp is None:
        return False
    if exp < time.time():
        banned_cids.pop(cid, None)
        return False
    return True


def record_report_against(cid: str, reason: str) -> bool:
    """Record a report on `cid`; return True iff this triggered a ban."""
    if not cid:
        return False
    now = time.time()
    q = report_counts[cid]
    while q and now - q[0] > REPORT_WINDOW_SEC:
        q.popleft()
    q.append(now)
    if len(q) >= REPORT_BAN_THRESHOLD and not is_banned(cid):
        banned_cids[cid] = now + BAN_DURATION_SEC
        try:
            with BANS_FILE.open("a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "client_id": cid,
                    "reason": reason,
                    "banned_at": datetime.now(timezone.utc).isoformat(),
                    "expires_at": datetime.fromtimestamp(banned_cids[cid], tz=timezone.utc).isoformat(),
                }, ensure_ascii=False) + "\n")
        except OSError as e:
            logger.error(f"Could not persist ban: {e}")
        logger.warning(f"AUTO-BAN: {cid} until {banned_cids[cid]}")
        return True
    return False


# ── WEBSOCKET SIGNALING ──────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    ip = client_ip(ws)
    if not ip_admit(ip):
        logger.warning(f"IP gate rejected new connection from {ip}")
        await ws.close(code=1008)  # policy violation
        return

    await ws.accept()
    ip_active[ip] += 1
    logger.info(f"New connection from {ip} (active for IP: {ip_active[ip]})")

    ws_profile[ws] = {
        "interests": [],
        "country_code": "",
        "country_name": "",
        "client_id": "",
    }
    ws_msg_times[ws] = deque()

    # If CAPTCHA is disabled (private network, dev override), auto-verify.
    if not TURNSTILE_REQUIRED:
        verified_ws.add(ws)

    await ws.send_json({"type": "ready"})

    try:
        while True:
            data = await ws.receive_text()

            # Size + rate gates BEFORE parsing
            if len(data) > MAX_MSG_BYTES:
                logger.warning("Dropping oversized message")
                continue
            if not check_rate_limit(ws):
                logger.warning("Rate limit exceeded for connection")
                continue

            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue

            mtype = msg.get("type")
            if mtype not in ALLOWED_TYPES:
                continue

            # ── CAPTCHA gate ──
            if mtype == "captcha":
                if ws in verified_ws:
                    await ws.send_json({"type": "captcha_ok"})
                    continue

                session_token   = str(msg.get("session_token", ""))[:200]
                turnstile_token = str(msg.get("turnstile_token", ""))[:2048]

                if session_token and verify_session_token(session_token):
                    verified_ws.add(ws)
                    await ws.send_json({"type": "captcha_ok"})
                    continue

                if await verify_turnstile(turnstile_token, ip):
                    verified_ws.add(ws)
                    await ws.send_json({
                        "type": "captcha_ok",
                        "session_token": make_session_token(),
                    })
                    continue

                await ws.send_json({"type": "captcha_failed"})
                continue

            # Every other type requires verification first.
            if ws not in verified_ws:
                await ws.send_json({"type": "captcha_failed"})
                continue

            # ── Profile sent: now match ──
            if mtype == "connect":
                profile = {
                    "interests": [str(x)[:30] for x in (msg.get("interests") or [])][:10],
                    "country_code": str(msg.get("country_code", ""))[:4],
                    "country_name": str(msg.get("country_name", ""))[:60],
                    "client_id": str(msg.get("client_id", ""))[:64],
                }
                # Refuse to match banned clients
                if is_banned(profile["client_id"]):
                    expires_at = banned_cids.get(profile["client_id"], 0)
                    try:
                        await ws.send_json({
                            "type": "banned",
                            "expires_at": expires_at,
                            "msg": "You've been temporarily blocked after multiple reports.",
                        })
                    except Exception:
                        pass
                    continue
                ws_profile[ws] = profile
                remove_from_pool(ws)
                await try_match(ws, profile)
                continue

            # ── User wants a new match ──
            if mtype == "requeue":
                peer = cleanup_room_for(ws)
                if peer is not None:
                    try:
                        await peer.send_json({"type": "peer_disconnected"})
                    except Exception:
                        pass
                remove_from_pool(ws)
                await try_match(ws, ws_profile.get(ws, {}))
                continue

            # ── Relay (offer / answer / ice / chat) ──
            room_id = msg.get("room")
            if not isinstance(room_id, str) or room_id not in rooms:
                continue
            peers = rooms[room_id]
            if ws not in peers:
                # Sender is not a member of this room — refuse to relay.
                continue

            if mtype == "chat":
                text = msg.get("text")
                if not isinstance(text, str) or not text:
                    continue
                msg["text"] = text[:MAX_CHAT_LEN]
                data = json.dumps(msg)

            for peer in peers:
                if peer is not ws:
                    try:
                        await peer.send_text(data)
                    except Exception:
                        pass

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WS error: {e}")
    finally:
        remove_from_pool(ws)
        peer = cleanup_room_for(ws)
        if peer is not None:
            try:
                await peer.send_json({"type": "peer_disconnected"})
            except Exception:
                pass
        ws_profile.pop(ws, None)
        ws_msg_times.pop(ws, None)
        verified_ws.discard(ws)
        ip_release(ip)


# ── STATIC FILES ─────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
