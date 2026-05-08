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


# ── WEBSOCKET SIGNALING ──────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("New connection")

    if waiting_queue:
        partner = waiting_queue.pop(0)
        room_id = str(id(ws))
        rooms[room_id] = [partner, ws]
        await partner.send_json({"type": "matched", "role": "caller", "room": room_id})
        await ws.send_json({"type": "matched", "role": "callee", "room": room_id})
        logger.info(f"Matched room {room_id}")
    else:
        waiting_queue.append(ws)
        await ws.send_json({"type": "waiting"})

    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            room_id = msg.get("room")

            # Relay ALL message types (offer, answer, ice, chat) to peer
            if room_id and room_id in rooms:
                for peer in rooms[room_id]:
                    if peer != ws:
                        await peer.send_text(data)

    except WebSocketDisconnect:
        logger.info("Client disconnected")

        # Remove from waiting queue
        if ws in waiting_queue:
            waiting_queue.remove(ws)

        # Notify peer and clean up room
        for rid, peers in list(rooms.items()):
            if ws in peers:
                for peer in peers:
                    if peer != ws:
                        try:
                            await peer.send_json({"type": "peer_disconnected"})
                        except Exception:
                            pass
                del rooms[rid]
                logger.info(f"Closed room {rid}")
                break


# ── STATIC FILES ─────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
