"""
Admin dashboard for NexTalk.

Auth: single shared password from env ADMIN_PASSWORD. After successful login
we set a signed cookie that lasts 8 hours. Cookie value is hmac(secret, "admin")
so it doesn't leak the password. Same SESSION_SECRET as the rest of the app.

All routes live under /admin/*. Static admin.html is served as a separate
file from the frontend folder; this module provides the JSON APIs the page
uses plus the login/logout flow.
"""
from fastapi import APIRouter, Request, Response, HTTPException, Form
from fastapi.responses import JSONResponse, RedirectResponse, HTMLResponse, FileResponse
from pathlib import Path
import base64
import hashlib
import hmac
import os
import secrets
import time

from . import db

ADMIN_PASSWORD     = os.getenv("ADMIN_PASSWORD", "")
ADMIN_COOKIE_NAME  = "nextalk_admin"
ADMIN_COOKIE_TTL   = 8 * 60 * 60   # 8h
SESSION_SECRET     = os.getenv("SESSION_SECRET") or secrets.token_hex(32)

router = APIRouter(prefix="/admin")


def _sign(payload: str) -> str:
    sig = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).rstrip(b"=").decode()


def _make_cookie() -> str:
    exp = int(time.time()) + ADMIN_COOKIE_TTL
    nonce = secrets.token_hex(8)
    payload = f"admin.{nonce}.{exp}"
    return f"{payload}.{_sign(payload)}"


def _verify_cookie(cookie: str) -> bool:
    if not cookie or len(cookie) > 256:
        return False
    try:
        prefix, nonce, exp_str, sig = cookie.split(".", 3)
        if prefix != "admin":
            return False
        if int(exp_str) < time.time():
            return False
        return hmac.compare_digest(sig, _sign(f"admin.{nonce}.{exp_str}"))
    except Exception:
        return False


def is_admin(request: Request) -> bool:
    return _verify_cookie(request.cookies.get(ADMIN_COOKIE_NAME, ""))


def require_admin(request: Request):
    if not is_admin(request):
        raise HTTPException(status_code=401, detail="not authorized")


# ── Login / logout / status ────────────────────────────────────
LOGIN_HTML = """<!doctype html>
<html><head><meta charset="utf-8"/><title>NexTalk admin</title>
<link rel="stylesheet" href="/styles.css">
<style>
body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.login-card {
  background: rgba(34,28,25,0.85); backdrop-filter: blur(30px);
  border: 0.5px solid rgba(255,255,255,0.12);
  border-radius: 18px; padding: 32px; width: 360px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.login-card h2 { margin: 0 0 18px; font-family: 'Syne',sans-serif; }
.login-card input {
  width: 100%; padding: 10px 12px; border-radius: 10px;
  background: rgba(255,255,255,0.08); border: 0.5px solid rgba(255,255,255,0.18);
  color: #f5efe8; font: inherit; outline: none; margin-bottom: 12px;
}
.login-card button {
  width: 100%; padding: 11px; border: none; border-radius: 10px;
  background: linear-gradient(135deg,#f97316,#be185d);
  color: #fff; font-weight: 600; cursor: pointer;
}
.err { color: #ef4444; font-size: 12px; margin-top: 8px; min-height: 16px; }
</style></head><body>
<div class="login-card">
  <h2>Admin login</h2>
  <form method="POST" action="/admin/login">
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Sign in</button>
    <div class="err">__ERR__</div>
  </form>
</div></body></html>"""


@router.get("/")
async def admin_root(request: Request):
    if is_admin(request):
        # Serve the dashboard SPA
        path = Path(__file__).resolve().parent.parent / "frontend" / "admin.html"
        if path.exists():
            return FileResponse(path)
        return HTMLResponse("<h1>admin.html missing</h1>", status_code=500)
    return HTMLResponse(LOGIN_HTML.replace("__ERR__", ""))


@router.post("/login")
async def admin_login(request: Request, password: str = Form(...)):
    if not ADMIN_PASSWORD:
        return HTMLResponse(
            LOGIN_HTML.replace("__ERR__", "ADMIN_PASSWORD env var not set on server"),
            status_code=500,
        )
    if not hmac.compare_digest(password, ADMIN_PASSWORD):
        return HTMLResponse(
            LOGIN_HTML.replace("__ERR__", "Wrong password"),
            status_code=401,
        )
    resp = RedirectResponse("/admin/", status_code=303)
    resp.set_cookie(
        ADMIN_COOKIE_NAME,
        _make_cookie(),
        max_age=ADMIN_COOKIE_TTL,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
    )
    return resp


@router.post("/logout")
async def admin_logout():
    resp = RedirectResponse("/admin/", status_code=303)
    resp.delete_cookie(ADMIN_COOKIE_NAME)
    return resp


# ── JSON API for the dashboard ──────────────────────────────────
@router.get("/api/stats")
async def api_stats(request: Request):
    require_admin(request)
    return db.dashboard_stats()


@router.get("/api/reports")
async def api_reports(request: Request, limit: int = 100):
    require_admin(request)
    return {"reports": db.list_reports(limit=limit)}


@router.get("/api/bans")
async def api_bans(request: Request, limit: int = 200):
    require_admin(request)
    return {"bans": db.list_active_bans(limit=limit)}


class _BanIn(dict):
    pass


@router.post("/api/ban")
async def api_ban(request: Request):
    require_admin(request)
    body = await request.json()
    cid = str(body.get("client_id", ""))[:64]
    ip = str(body.get("ip", ""))[:64]
    reason = str(body.get("reason", ""))[:200]
    duration_h = body.get("duration_hours")
    if cid == "" and ip == "":
        return JSONResponse({"error": "client_id or ip required"}, status_code=400)
    duration = float(duration_h) * 3600 if duration_h else None
    ban_id = db.insert_ban(
        client_id=cid, ip=ip, reason=reason,
        duration_sec=duration, banned_by="admin",
    )
    return {"ok": True, "ban_id": ban_id}


@router.post("/api/unban")
async def api_unban(request: Request):
    require_admin(request)
    body = await request.json()
    ban_id = int(body.get("ban_id", 0))
    if not ban_id:
        return JSONResponse({"error": "ban_id required"}, status_code=400)
    ok = db.unban(ban_id)
    return {"ok": ok}
