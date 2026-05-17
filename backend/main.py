from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from datetime import datetime
from collections import defaultdict
import json, asyncio, logging, time, hashlib

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# ── STATE ────────────────────────────────────────────────────────
# Each entry: {"ws": WebSocket, "profile": {...}, "queued_at": float}
waiting_pool: list[dict] = []
rooms: dict[str, list[WebSocket]] = {}
reports: list[dict] = []

# Per-client rating storage (in-memory; swap for DB later)
# client_id -> {"sum": float, "count": int, "avg": float}
ratings: dict[str, dict] = defaultdict(lambda: {"sum": 0.0, "count": 0, "avg": 0.0})

# ws -> profile (so we can look up after match)
ws_profile: dict[WebSocket, dict] = {}

# Wait time before falling back to "match anyone" if no interest overlap
MAX_PICKY_WAIT_SEC = 10.0


# ── REPORT ENDPOINT ─────────────────────────────────────────────
class ReportPayload(BaseModel):
    room: str
    reason: str
    details: str = ""

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}

@app.post("/report")
async def submit_report(payload: ReportPayload):
    entry = {
        "room": payload.room,
        "reason": payload.reason,
        "details": payload.details,
        "timestamp": datetime.utcnow().isoformat()
    }
    reports.append(entry)
    logger.warning(f"REPORT: {entry}")
    return JSONResponse({"status": "received"})


# ── RATING ENDPOINT ─────────────────────────────────────────────
class RatePayload(BaseModel):
    target_client_id: str   # who is being rated
    rater_client_id: str    # who is rating
    score: int              # 1 (thumbs up) or -1 (thumbs down)

@app.post("/rate")
async def submit_rating(payload: RatePayload):
    if payload.score not in (1, -1):
        return JSONResponse({"status": "error", "msg": "invalid score"}, status_code=400)
    if payload.target_client_id == payload.rater_client_id:
        return JSONResponse({"status": "error", "msg": "cannot self-rate"}, status_code=400)

    # Normalize: +1 → 5 stars, -1 → 1 star (so avg stays on 1-5 scale)
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
        "online": len(ws_profile),
        "waiting": len(waiting_pool),
        "in_chat": len(ws_profile) - len(waiting_pool),
    }


# ── MATCHING HELPERS ─────────────────────────────────────────────
def score_match(my_profile: dict, their_profile: dict) -> int:
    """Higher = better match. Based on interest overlap + similar rating tier."""
    my_interests = set(i.lower().strip() for i in my_profile.get("interests", []))
    their_interests = set(i.lower().strip() for i in their_profile.get("interests", []))
    overlap = len(my_interests & their_interests)

    # Rating tier matching: small bonus if both are similarly rated
    my_avg = my_profile.get("rating_avg", 0)
    their_avg = their_profile.get("rating_avg", 0)
    rating_bonus = 0
    if my_avg > 0 and their_avg > 0:
        if abs(my_avg - their_avg) < 1.0:
            rating_bonus = 1

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
        "interests": profile.get("interests", []),
        "country_code": profile.get("country_code", ""),
        "country_name": profile.get("country_name", ""),
        "rating_avg": rating["avg"],
        "rating_count": rating["count"],
        "client_id": cid,   # peer needs this to rate us afterwards
    }


async def try_match(ws: WebSocket, profile: dict):
    """
    Try to match ws with the BEST available peer in the pool.
    If no good match and not waited long enough, stay queued.
    Otherwise, match with the longest-waiting person.
    """
    now = time.time()
    my_interests = set(i.lower().strip() for i in profile.get("interests", []))

    # Score everyone in the pool against us
    best_idx = -1
    best_score = -1
    for i, entry in enumerate(waiting_pool):
        if entry["ws"] is ws:
            continue
        s = score_match(profile, entry["profile"])
        # Older waiters get a slight time bonus to avoid starvation
        wait_time = now - entry["queued_at"]
        s += int(wait_time / 5)  # +1 per 5s waited
        if s > best_score:
            best_score = s
            best_idx = i

    # Decide: match now or keep waiting?
    should_match = False
    if best_idx >= 0:
        # If we have interest overlap (score >= 10), match immediately
        if best_score >= 10:
            should_match = True
        # Or if either side has waited long enough, fall back to anyone
        elif best_score >= 0:
            partner_wait = now - waiting_pool[best_idx]["queued_at"]
            if partner_wait > MAX_PICKY_WAIT_SEC or not my_interests:
                should_match = True

    if should_match:
        partner_entry = waiting_pool.pop(best_idx)
        partner = partner_entry["ws"]
        partner_profile = partner_entry["profile"]

        try:
            room_id = f"{int(now*1000)}-{id(ws) % 10000}"
            rooms[room_id] = [partner, ws]
            await partner.send_json({
                "type": "matched",
                "role": "caller",
                "room": room_id,
                "peer": public_profile(profile),
            })
            await ws.send_json({
                "type": "matched",
                "role": "callee",
                "room": room_id,
                "peer": public_profile(partner_profile),
            })
            logger.info(f"Matched room {room_id} (score={best_score})")
            return
        except Exception as e:
            logger.warning(f"Match send failed: {e}")
            # Fall through to re-queue ourselves

    # No match — add to pool
    if not any(e["ws"] is ws for e in waiting_pool):
        waiting_pool.append({"ws": ws, "profile": profile, "queued_at": now})

    try:
        await ws.send_json({
            "type": "waiting",
            "online": len(ws_profile),
        })
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
            logger.info(f"Closed room {rid}")
            return peer
    return None


# ── WEBSOCKET SIGNALING ──────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("New connection")

    # Default empty profile until client sends one
    ws_profile[ws] = {
        "interests": [],
        "country_code": "",
        "country_name": "",
        "client_id": "",
    }

    # Don't auto-match yet — wait for client to send profile via "connect"
    await ws.send_json({"type": "ready"})

    try:
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            # ── Profile sent: now match ──
            if mtype == "connect":
                profile = {
                    "interests": [str(x)[:30] for x in (msg.get("interests") or [])][:10],
                    "country_code": str(msg.get("country_code", ""))[:4],
                    "country_name": str(msg.get("country_name", ""))[:60],
                    "client_id": str(msg.get("client_id", ""))[:64],
                }
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

            # ── Relay signaling/chat to peer ──
            room_id = msg.get("room")
            if room_id and room_id in rooms:
                for peer in rooms[room_id]:
                    if peer is not ws:
                        try:
                            await peer.send_text(data)
                        except Exception:
                            pass

    except WebSocketDisconnect:
        logger.info("Client disconnected")
        remove_from_pool(ws)
        peer = cleanup_room_for(ws)
        if peer is not None:
            try:
                await peer.send_json({"type": "peer_disconnected"})
            except Exception:
                pass
        ws_profile.pop(ws, None)
    except Exception as e:
        logger.error(f"WS error: {e}")
        remove_from_pool(ws)
        ws_profile.pop(ws, None)


# ── STATIC FILES ─────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
