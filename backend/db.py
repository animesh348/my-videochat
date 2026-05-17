"""
SQLite persistence layer for NexTalk moderation.

Tables:
- reports : every /report POST (reason, target, reporter, room, timestamp, ip)
- bans    : active and historical bans (auto + manual)
- sessions: minimal match log (room, two cids, start/end, country pair)

Schema is created idempotently on import. DB file path comes from env
NEXTALK_DB_PATH (defaults to nextalk.db in CWD). On Render free tier the file
wipes on each restart; on Starter+ with a persistent disk it survives.
"""
from pathlib import Path
from datetime import datetime, timezone
import os
import sqlite3
import threading
import time
from typing import Optional

DB_PATH = Path(os.getenv("NEXTALK_DB_PATH", "nextalk.db"))

# SQLite connections aren't safe to share across threads without a lock.
# Uvicorn runs us in an asyncio event loop on a single thread normally, but
# some operations (Turnstile verify) run in an executor — so use a lock.
_lock = threading.RLock()
_conn: Optional[sqlite3.Connection] = None


def _get() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(
            DB_PATH,
            check_same_thread=False,
            isolation_level=None,  # autocommit
        )
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode = WAL;")
        _conn.execute("PRAGMA synchronous = NORMAL;")
        _create_schema(_conn)
    return _conn


def _create_schema(c: sqlite3.Connection) -> None:
    c.executescript("""
        CREATE TABLE IF NOT EXISTS reports (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts              REAL    NOT NULL,
            room            TEXT,
            reason          TEXT    NOT NULL,
            details         TEXT,
            rater_client_id TEXT,
            target_client_id TEXT,
            rater_ip        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_reports_ts     ON reports(ts);
        CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_client_id);

        CREATE TABLE IF NOT EXISTS bans (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id    TEXT,
            ip           TEXT,
            reason       TEXT,
            banned_at    REAL    NOT NULL,
            expires_at   REAL,
            banned_by    TEXT,
            active       INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_bans_cid_active ON bans(client_id, active);
        CREATE INDEX IF NOT EXISTS idx_bans_ip_active  ON bans(ip, active);

        CREATE TABLE IF NOT EXISTS sessions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            room         TEXT,
            cid_a        TEXT,
            cid_b        TEXT,
            country_a    TEXT,
            country_b    TEXT,
            started_at   REAL    NOT NULL,
            ended_at     REAL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    """)


# ── Reports ─────────────────────────────────────────────────────
def insert_report(
    room: str, reason: str, details: str,
    rater_client_id: str, target_client_id: str, rater_ip: str
) -> int:
    with _lock:
        cur = _get().execute(
            """INSERT INTO reports
               (ts, room, reason, details, rater_client_id, target_client_id, rater_ip)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (time.time(), room, reason, details, rater_client_id, target_client_id, rater_ip),
        )
        return cur.lastrowid


def list_reports(limit: int = 200) -> list[dict]:
    with _lock:
        rows = _get().execute(
            "SELECT * FROM reports ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def reports_against(target_client_id: str, since_ts: float) -> int:
    with _lock:
        row = _get().execute(
            "SELECT COUNT(*) AS n FROM reports WHERE target_client_id = ? AND ts >= ?",
            (target_client_id, since_ts),
        ).fetchone()
    return int(row["n"] or 0)


# ── Bans ────────────────────────────────────────────────────────
def insert_ban(
    client_id: str = "", ip: str = "", reason: str = "",
    duration_sec: Optional[float] = None, banned_by: str = "auto"
) -> int:
    now = time.time()
    expires = now + duration_sec if duration_sec else None
    with _lock:
        cur = _get().execute(
            """INSERT INTO bans (client_id, ip, reason, banned_at, expires_at, banned_by, active)
               VALUES (?, ?, ?, ?, ?, ?, 1)""",
            (client_id or "", ip or "", reason, now, expires, banned_by),
        )
        return cur.lastrowid


def is_banned(client_id: str = "", ip: str = "") -> Optional[dict]:
    """Return the active ban row if either client_id or ip is currently banned."""
    if not client_id and not ip:
        return None
    now = time.time()
    with _lock:
        c = _get()
        # Expire stale ones first
        c.execute(
            "UPDATE bans SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at < ?",
            (now,),
        )
        params = []
        clauses = []
        if client_id:
            clauses.append("client_id = ?")
            params.append(client_id)
        if ip:
            clauses.append("ip = ?")
            params.append(ip)
        sql = f"SELECT * FROM bans WHERE active = 1 AND ({' OR '.join(clauses)}) LIMIT 1"
        row = c.execute(sql, params).fetchone()
    return dict(row) if row else None


def list_active_bans(limit: int = 200) -> list[dict]:
    now = time.time()
    with _lock:
        c = _get()
        c.execute(
            "UPDATE bans SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at < ?",
            (now,),
        )
        rows = c.execute(
            "SELECT * FROM bans WHERE active = 1 ORDER BY banned_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def unban(ban_id: int) -> bool:
    with _lock:
        cur = _get().execute("UPDATE bans SET active = 0 WHERE id = ?", (ban_id,))
        return cur.rowcount > 0


# ── Sessions ────────────────────────────────────────────────────
def session_start(room: str, cid_a: str, cid_b: str, country_a: str, country_b: str) -> None:
    with _lock:
        _get().execute(
            """INSERT INTO sessions (room, cid_a, cid_b, country_a, country_b, started_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (room, cid_a, cid_b, country_a, country_b, time.time()),
        )


def session_end(room: str) -> None:
    with _lock:
        _get().execute(
            "UPDATE sessions SET ended_at = ? WHERE room = ? AND ended_at IS NULL",
            (time.time(), room),
        )


# ── Stats for dashboard ────────────────────────────────────────
def dashboard_stats() -> dict:
    now = time.time()
    day_ago = now - 24 * 60 * 60
    week_ago = now - 7 * 24 * 60 * 60
    with _lock:
        c = _get()
        c.execute(
            "UPDATE bans SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at < ?",
            (now,),
        )
        reports_24h = c.execute("SELECT COUNT(*) AS n FROM reports WHERE ts >= ?", (day_ago,)).fetchone()["n"]
        reports_total = c.execute("SELECT COUNT(*) AS n FROM reports").fetchone()["n"]
        matches_24h = c.execute("SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?", (day_ago,)).fetchone()["n"]
        matches_total = c.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]
        active_bans = c.execute("SELECT COUNT(*) AS n FROM bans WHERE active = 1").fetchone()["n"]

        # Top countries from sessions (last 7d)
        country_rows = c.execute("""
            SELECT country, COUNT(*) AS n FROM (
                SELECT country_a AS country FROM sessions WHERE started_at >= ?
                UNION ALL
                SELECT country_b AS country FROM sessions WHERE started_at >= ?
            )
            WHERE country IS NOT NULL AND country != ''
            GROUP BY country ORDER BY n DESC LIMIT 10
        """, (week_ago, week_ago)).fetchall()

        # Reports by reason (24h)
        reason_rows = c.execute(
            "SELECT reason, COUNT(*) AS n FROM reports WHERE ts >= ? GROUP BY reason ORDER BY n DESC",
            (day_ago,),
        ).fetchall()

    return {
        "reports_24h": reports_24h,
        "reports_total": reports_total,
        "matches_24h": matches_24h,
        "matches_total": matches_total,
        "active_bans": active_bans,
        "top_countries": [dict(r) for r in country_rows],
        "reasons_24h": [dict(r) for r in reason_rows],
    }
