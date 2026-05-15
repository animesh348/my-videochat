from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from datetime import datetime
import json, asyncio, logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

waiting_queue: list[WebSocket] = []
rooms: dict[str, list[WebSocket]] = {}
reports: list[dict] = []   # In-memory; swap for DB later


# ── REPORT ENDPOINT ─────────────────────────────────────────────
class ReportPayload(BaseModel):
    room: str
    reason: str
    details: str = ""

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


# ── HELPERS ──────────────────────────────────────────────────────
async def try_match(ws: WebSocket):
    """Try to match ws with someone in the queue. If no one, put ws in the queue."""
    # Pop a partner that's still alive
    while waiting_queue:
        partner = waiting_queue.pop(0)
        if partner is ws:
            continue  # never match with self
        try:
            room_id = str(id(ws))
            rooms[room_id] = [partner, ws]
            await partner.send_json({"type": "matched", "role": "caller", "room": room_id})
            await ws.send_json({"type": "matched", "role": "callee", "room": room_id})
            logger.info(f"Matched room {room_id}")
            return
        except Exception:
            # partner socket was dead, try the next one
            continue

    # No one available
    if ws not in waiting_queue:
        waiting_queue.append(ws)
    await ws.send_json({"type": "waiting"})


def cleanup_room_for(ws: WebSocket):
    """Remove ws from any room it's in and notify peer. Returns the peer (or None)."""
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

    await try_match(ws)

    try:
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            # ── Re-queue request: peer left / user clicked Next ──
            if mtype == "requeue":
                # Tear down any existing room for this socket
                peer = cleanup_room_for(ws)
                if peer is not None:
                    try:
                        await peer.send_json({"type": "peer_disconnected"})
                    except Exception:
                        pass
                # Make sure we're not duplicated in the queue
                if ws in waiting_queue:
                    waiting_queue.remove(ws)
                await try_match(ws)
                continue

            # ── Relay signaling/chat to the peer in the same room ──
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

        # Remove from waiting queue
        if ws in waiting_queue:
            waiting_queue.remove(ws)

        # Notify peer and clean up room
        peer = cleanup_room_for(ws)
        if peer is not None:
            try:
                await peer.send_json({"type": "peer_disconnected"})
            except Exception:
                pass


# ── STATIC FILES ─────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
