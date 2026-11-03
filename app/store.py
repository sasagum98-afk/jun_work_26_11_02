"""PC 내부 저장 (SQLite): 사용자, 설정, 검수 회차, 품목, 자료 보관."""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    rank TEXT NOT NULL,
    name TEXT NOT NULL,
    unit_code TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    unit_code TEXT PRIMARY KEY,
    managers TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_code TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    vendor TEXT NOT NULL,
    started_at TEXT NOT NULL,
    closed_at TEXT,
    reported INTEGER NOT NULL DEFAULT 0,
    reported_at TEXT
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inspection_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    barcode TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,
    match TEXT NOT NULL DEFAULT '',
    basis TEXT NOT NULL DEFAULT '',
    source_seq TEXT NOT NULL DEFAULT '',
    grade TEXT NOT NULL DEFAULT '',
    defect_type TEXT NOT NULL DEFAULT '',
    maker TEXT NOT NULL DEFAULT '',
    mfg_date TEXT NOT NULL DEFAULT '',
    exp_date TEXT NOT NULL DEFAULT '',
    qty TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    suggested TEXT NOT NULL DEFAULT '',
    final TEXT NOT NULL DEFAULT '',
    modified INTEGER NOT NULL DEFAULT 0,
    photo_path TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS cache (
    service TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    data TEXT NOT NULL
);
"""

ITEM_FIELDS = ["name", "barcode", "method", "result", "match", "basis", "source_seq", "grade",
               "defect_type", "maker", "mfg_date", "exp_date", "qty", "unit", "suggested",
               "final", "modified", "memo", "detail"]
ITEM_EDITABLE = ["name", "defect_type", "maker", "mfg_date", "exp_date", "qty", "unit", "final", "memo"]


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def hash_password(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), 200_000)
    return f"pbkdf2_sha256$200000${salt}${dk.hex()}"


def check_password(pw, stored):
    try:
        _, iters, salt, h = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), h)
    except (ValueError, TypeError):
        return False


class Store:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.write_lock = threading.Lock()
        with self.conn() as c:
            c.executescript(SCHEMA)

    def conn(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        return c

    def _one(self, sql, args=()):
        with self.conn() as c:
            r = c.execute(sql, args).fetchone()
            return dict(r) if r else None

    def _all(self, sql, args=()):
        with self.conn() as c:
            return [dict(r) for r in c.execute(sql, args).fetchall()]

    def _run(self, sql, args=()):
        with self.write_lock, self.conn() as c:
            cur = c.execute(sql, args)
            return cur.lastrowid

    # ---------------------------------------------------------- 사용자

    def create_user(self, username, pw, rank, name, unit_code):
        return self._run(
            "INSERT INTO users (username, pw_hash, rank, name, unit_code, created_at) VALUES (?,?,?,?,?,?)",
            (username, hash_password(pw), rank, name, unit_code, now()))

    def user_by_name(self, username):
        return self._one("SELECT * FROM users WHERE username=?", (username,))

    def user(self, uid):
        return self._one("SELECT id, username, rank, name, unit_code, created_at FROM users WHERE id=?", (uid,))

    def update_user(self, uid, rank, name):
        self._run("UPDATE users SET rank=?, name=? WHERE id=?", (rank, name, uid))

    def new_session(self, uid):
        token = secrets.token_urlsafe(32)
        self._run("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)", (token, uid, now()))
        return token

    def session_user(self, token):
        if not token:
            return None
        s = self._one("SELECT user_id FROM sessions WHERE token=?", (token,))
        return self.user(s["user_id"]) if s else None

    def drop_session(self, token):
        self._run("DELETE FROM sessions WHERE token=?", (token,))

    # ---------------------------------------------------------- 설정

    def managers(self, unit):
        r = self._one("SELECT managers FROM settings WHERE unit_code=?", (unit,))
        return json.loads(r["managers"]) if r else []

    def set_managers(self, unit, managers):
        self._run("INSERT INTO settings (unit_code, managers) VALUES (?,?) "
                  "ON CONFLICT(unit_code) DO UPDATE SET managers=excluded.managers",
                  (unit, json.dumps(managers, ensure_ascii=False)))

    # ---------------------------------------------------------- 검수

    def create_inspection(self, user, vendor):
        return self._run(
            "INSERT INTO inspections (unit_code, user_id, author, vendor, started_at) VALUES (?,?,?,?,?)",
            (user["unit_code"], user["id"], f"{user['rank']} {user['name']}", vendor, now()))

    def inspection(self, iid, unit):
        return self._one("SELECT * FROM inspections WHERE id=? AND unit_code=?", (iid, unit))

    def current_inspection(self, uid):
        return self._one("SELECT * FROM inspections WHERE user_id=? AND closed_at IS NULL ORDER BY id DESC LIMIT 1", (uid,))

    def set_vendor(self, iid, vendor):
        self._run("UPDATE inspections SET vendor=? WHERE id=?", (vendor, iid))

    def close_inspection(self, iid):
        self._run("UPDATE inspections SET closed_at=? WHERE id=? AND closed_at IS NULL", (now(), iid))

    def unmark_reported(self, iid):
        """보고 뒤 이상 품목이 더 담기면 다시 '보고 전'으로 (지난 보고 시각은 남김)"""
        self._run("UPDATE inspections SET reported=0 WHERE id=?", (iid,))

    def mark_reported(self, iid):
        self._run("UPDATE inspections SET reported=1, reported_at=? WHERE id=?", (now(), iid))

    def inspections(self, unit):
        return self._all(
            "SELECT i.*, "
            " (SELECT COUNT(*) FROM items t WHERE t.inspection_id=i.id AND t.result='pass') AS pass_count, "
            " (SELECT COUNT(*) FROM items t WHERE t.inspection_id=i.id AND t.result='issue') AS issue_count "
            "FROM inspections i WHERE unit_code=? ORDER BY i.started_at DESC, i.id DESC", (unit,))

    def vendors(self, unit):
        return [r["vendor"] for r in self._all(
            "SELECT vendor, MAX(started_at) m FROM inspections WHERE unit_code=? GROUP BY vendor ORDER BY m DESC", (unit,))]

    # ---------------------------------------------------------- 품목

    def add_item(self, iid, data):
        cols = ["inspection_id", "created_at"] + ITEM_FIELDS
        vals = [iid, now()] + [data.get(f, 0 if f == "modified" else "") for f in ITEM_FIELDS]
        return self._run(f"INSERT INTO items ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)

    def items(self, iid):
        return self._all("SELECT * FROM items WHERE inspection_id=? ORDER BY id", (iid,))

    def item(self, item_id, unit):
        return self._one(
            "SELECT t.* FROM items t JOIN inspections i ON i.id=t.inspection_id WHERE t.id=? AND i.unit_code=?",
            (item_id, unit))

    def update_item(self, item_id, fields):
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        self._run(f"UPDATE items SET {sets} WHERE id=?", list(fields.values()) + [item_id])

    def delete_item(self, item_id):
        self._run("DELETE FROM items WHERE id=?", (item_id,))

    def all_items(self, unit):
        return self._all(
            "SELECT t.*, i.vendor, i.author, i.started_at, i.reported, i.reported_at FROM items t "
            "JOIN inspections i ON i.id=t.inspection_id WHERE i.unit_code=? ORDER BY i.started_at, t.id", (unit,))

    # ---------------------------------------------------------- 자료 보관

    def cache_get(self, svc):
        return self._one("SELECT service, fetched_at, data FROM cache WHERE service=?", (svc,))

    def cache_put(self, svc, fetched_at, data):
        self._run("INSERT INTO cache (service, fetched_at, data) VALUES (?,?,?) "
                  "ON CONFLICT(service) DO UPDATE SET fetched_at=excluded.fetched_at, data=excluded.data",
                  (svc, fetched_at, data))
