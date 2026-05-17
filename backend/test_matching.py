"""Unit tests for the pure matching / rating helpers in backend.main."""

import time

import pytest

from backend import main


@pytest.fixture(autouse=True)
def reset_state():
    """Each test gets fresh module-level state."""
    main.waiting_pool.clear()
    main.rooms.clear()
    main.room_pairs.clear()
    main.ratings.clear()
    main.rate_grants.clear()
    main.report_counts.clear()
    main.banned_cids.clear()
    main.ws_profile.clear()
    main.ws_msg_times.clear()
    main.ip_active.clear()
    main.ip_recent.clear()
    yield


# ── score_match ────────────────────────────────────────────────
def test_score_match_overlap_dominates():
    """Each interest in common is worth 10 points."""
    a = {"interests": ["music", "anime", "coding"]}
    b = {"interests": ["music", "anime", "fishing"]}
    assert main.score_match(a, b) == 20


def test_score_match_is_case_insensitive_and_strips():
    a = {"interests": ["  Music ", "ANIME"]}
    b = {"interests": ["music", "anime"]}
    assert main.score_match(a, b) == 20


def test_score_match_no_overlap_is_zero():
    a = {"interests": ["music"]}
    b = {"interests": ["fishing"]}
    assert main.score_match(a, b) == 0


def test_score_match_rating_bonus_when_similar():
    """Both rated, within 1 star → +1 bonus on top of overlap."""
    a = {"interests": ["music"], "rating_avg": 4.5}
    b = {"interests": ["music"], "rating_avg": 4.2}
    assert main.score_match(a, b) == 11   # 10 overlap + 1 bonus


def test_score_match_no_rating_bonus_when_far_apart():
    a = {"interests": ["music"], "rating_avg": 4.5}
    b = {"interests": ["music"], "rating_avg": 2.0}
    assert main.score_match(a, b) == 10


def test_score_match_no_rating_bonus_when_one_is_unrated():
    a = {"interests": ["music"], "rating_avg": 0}
    b = {"interests": ["music"], "rating_avg": 4.5}
    assert main.score_match(a, b) == 10


# ── get_rating_for / public_profile ─────────────────────────────
def test_get_rating_for_unrated_returns_zero():
    assert main.get_rating_for("nobody") == {"avg": 0, "count": 0}


def test_get_rating_for_after_rating():
    main.ratings["c1"]["sum"] = 10.0
    main.ratings["c1"]["count"] = 2
    main.ratings["c1"]["avg"] = 5.0
    assert main.get_rating_for("c1") == {"avg": 5.0, "count": 2}


def test_public_profile_exposes_only_safe_fields():
    profile = {
        "client_id": "c1",
        "interests": ["music"],
        "country_code": "US",
        "country_name": "United States",
        "secret_field": "should-not-leak",
    }
    pub = main.public_profile(profile)
    assert "secret_field" not in pub
    assert pub["client_id"] == "c1"
    assert pub["interests"] == ["music"]
    assert pub["country_code"] == "US"
    assert pub["country_name"] == "United States"
    assert pub["rating_avg"] == 0
    assert pub["rating_count"] == 0


# ── ban + report bookkeeping ───────────────────────────────────
def test_is_banned_false_for_empty_cid():
    assert main.is_banned("") is False


def test_is_banned_expires():
    main.banned_cids["c1"] = time.time() - 1
    assert main.is_banned("c1") is False
    assert "c1" not in main.banned_cids   # auto-cleaned


def test_record_report_triggers_ban_at_threshold(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "BANS_FILE", tmp_path / "bans.jsonl")
    monkeypatch.setattr(main, "REPORT_BAN_THRESHOLD", 3)
    triggered = [main.record_report_against("c1", "hate") for _ in range(3)]
    assert triggered == [False, False, True]
    assert main.is_banned("c1") is True


def test_record_report_no_ban_below_threshold(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "BANS_FILE", tmp_path / "bans.jsonl")
    monkeypatch.setattr(main, "REPORT_BAN_THRESHOLD", 3)
    main.record_report_against("c1", "hate")
    main.record_report_against("c1", "hate")
    assert main.is_banned("c1") is False


def test_record_report_empty_cid_is_noop():
    assert main.record_report_against("", "hate") is False
    assert not main.banned_cids


# ── IP gate ────────────────────────────────────────────────────
def test_ip_admit_allows_first_connection():
    assert main.ip_admit("1.2.3.4") is True


def test_ip_admit_blocks_when_concurrent_limit_hit(monkeypatch):
    monkeypatch.setattr(main, "IP_MAX_CONCURRENT", 2)
    main.ip_active["1.2.3.4"] = 2
    assert main.ip_admit("1.2.3.4") is False


def test_ip_admit_blocks_when_rate_limit_hit(monkeypatch):
    monkeypatch.setattr(main, "IP_MAX_PER_MIN", 3)
    for _ in range(3):
        assert main.ip_admit("1.2.3.4") is True
    assert main.ip_admit("1.2.3.4") is False


def test_ip_release_decrements_and_cleans_up():
    main.ip_active["1.2.3.4"] = 1
    main.ip_release("1.2.3.4")
    assert "1.2.3.4" not in main.ip_active


# ── Session tokens (CAPTCHA tickets) ───────────────────────────
def test_session_token_roundtrip():
    tok = main.make_session_token()
    assert main.verify_session_token(tok) is True


def test_session_token_rejects_tampered_signature():
    tok = main.make_session_token()
    # Flip last char of signature
    bad = tok[:-1] + ("A" if tok[-1] != "A" else "B")
    assert main.verify_session_token(bad) is False


def test_session_token_rejects_expired(monkeypatch):
    # Issue a token, then jump time forward past TTL.
    tok = main.make_session_token()
    real_time = main.time.time
    monkeypatch.setattr(main.time, "time",
                        lambda: real_time() + main.SESSION_TTL_SEC + 10)
    assert main.verify_session_token(tok) is False


def test_session_token_rejects_garbage():
    assert main.verify_session_token("") is False
    assert main.verify_session_token("not.a.token") is False
    assert main.verify_session_token("only-two.parts") is False
    assert main.verify_session_token("a" * 500) is False
