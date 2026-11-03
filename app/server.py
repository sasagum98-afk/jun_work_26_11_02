"""군 급식 식자재 안전 지키미 (베타).

- PC판: 이 PC(127.0.0.1)에서만 접속을 받습니다. 실행: `실행.cmd` 또는 `python app/server.py`
- 온라인판: Vercel 함수(api/index.py)가 이 Handler를 그대로 씀. 기록은 Supabase(DATABASE_URL)
"""
import csv
import io
import json
import mimetypes
import os
import re
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from foodsafety import FoodData  # noqa: E402
from store import ITEM_EDITABLE, check_password, open_store  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "static")
ONLINE = bool(os.environ.get("VERCEL"))  # Vercel이 넣어 주는 환경 변수
# 온라인판은 /tmp만 쓸 수 있음 (꺼지면 사라짐. 기록은 DB에 있음)
DATA = os.environ.get("GUNMEAL_DATA_DIR") or ("/tmp/gunmeal" if ONLINE else os.path.join(ROOT, "data"))
CONFIG = os.path.join(ROOT, "config")
MAX_PHOTO = 4_000_000 if ONLINE else 15_000_000  # Vercel은 요청 본문 4.5MB까지
APP_ID = "gunmeal-safety-beta"
PORTS = range(8765, 8776)
WEEKDAYS = "월화수목금토일"
DEFECT_TYPES = ["회수 이력", "검사부적합 이력", "해외직구 위해식품 이력", "변질", "포장 파손", "표시 누락", "이물", "기타"]
VISUAL_TYPES = ["변질", "포장 파손", "표시 누락", "이물", "기타"]
BASIS_DEFECT = {"I0490": "회수 이력", "I2620": "검사부적합 이력", "I2715": "해외직구 위해식품 이력"}
BASIS_LABEL = {"I0490": "I0490 회수·판매중지", "I2620": "I2620 검사부적합", "I2715": "I2715 해외직구 위해식품", "visual": "육안"}
METHOD_LABEL = {"barcode": "바코드", "ocr": "글자 인식", "manual": "입력"}
MATCH_LABEL = {"none": "후보 없음", "lot_match": "로트 일치", "lot_mismatch": "후보 있었으나 로트 불일치", "": ""}
PHOTO_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
IMAGE_EXT = {".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}
MAX_IMAGE = 15_000_000  # 식품안전나라 제품 사진은 원본 크기(가로 3000px 안팎)로 옴


def load_env():
    env = {}
    path = os.path.join(ROOT, ".env")
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("FOODSAFETY_KEY", "FOODSAFETY_BASE_URL"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def load_json(name, default):
    try:
        with open(os.path.join(CONFIG, name), encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def unit_codes():
    data = load_json("units.json", {"units": []})
    return {u["code"]: u for u in data.get("units", []) if u.get("code")}


def categories():
    return load_json("categories.json", {
        "categories": ["회수", "급식중단", "보고 후 결정"],
        "rules": {"I0490_1등급": "급식중단", "I0490_2등급": "회수", "I0490_3등급": "회수",
                  "I0490_자율회수": "회수", "I0490_등급없음": "보고 후 결정", "I2620": "회수",
                  "I2715": "급식중단", "육안": "보고 후 결정"}})


def suggest(basis, grade):
    rules = categories()["rules"]
    if basis == "I0490":
        g = grade or ""
        key = "I0490_등급없음"
        for n in "123":
            if n in g:
                key = f"I0490_{n}등급"
                break
        else:
            if "자율" in g:
                key = "I0490_자율회수"
        return rules.get(key, "보고 후 결정")
    if basis in ("I2620", "I2715"):
        return rules.get(basis, "보고 후 결정")
    return rules.get("육안", "보고 후 결정")


def fmt_when(ts):
    d = datetime.strptime(ts[:16], "%Y-%m-%d %H:%M")
    return f"{d:%Y-%m-%d}({WEEKDAYS[d.weekday()]}) {d:%H:%M}"


def defect_label(item):
    t = item["defect_type"] or "기타"
    if t == "회수 이력" and item["grade"]:
        return f"회수 이력({item['grade']})"
    if t in VISUAL_TYPES and item["basis"] == "visual":
        return f"{t}(육안)"
    return t


def report_text(unit, author, insp, items, when):
    lines = [f"[급식 이상 보고] 부대 {unit} / 작성 {author}", fmt_when(when)]
    for n, it in enumerate(items, 1):
        qty = f"{it['qty']}{it['unit']}" if it["qty"] else "수량 미기재"
        lines.append(f"{n}) {it['name'] or '품목명 미기재'} / {qty} / {insp['vendor']} / "
                     f"{defect_label(it)} / 건의: {it['final'] or it['suggested']}")
    lines.append("※ 사진·상세는 보고서 파일 별도")
    return "\n".join(lines)


def sniff_image(data):
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"GIF8":
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ""


def item_view(it):
    it = dict(it)
    try:
        it["detail"] = json.loads(it.get("detail") or "{}")
    except ValueError:
        it["detail"] = {}
    it["has_photo"] = bool(it.pop("photo_path", ""))
    it["defect_label"] = defect_label(it)
    return it


class App:
    def __init__(self):
        self.env = load_env()
        self.store = open_store(DATA)
        self.food = FoodData(self.store, self.env)


class Handler(BaseHTTPRequestHandler):
    app: App = None
    server_version = "GunMeal/0.1"

    def log_message(self, fmt, *args):  # 요청 주소에 개인정보가 섞이지 않게 간단히만
        pass

    # ---------------------------------------------------------- 공통

    def send_json(self, obj, code=200, headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, msg, code=400):
        self.send_json({"error": msg}, code)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("요청이 너무 큽니다")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def token(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return c["sid"].value if "sid" in c else ""

    def user(self):
        return self.app.store.session_user(self.token())

    def host_ok(self):
        if ONLINE:
            return True
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def cookie(self, value, max_age):
        secure = "; Secure" if ONLINE else ""
        return f"sid={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict{secure}"

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        if not self.host_ok():
            return self.fail("이 PC에서만 접속할 수 있습니다", 403)
        url = urlparse(self.path)
        path = url.path
        self.query = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if path.startswith("/api/"):
                return self.route_api(method, path[5:])
            if method != "GET":
                return self.fail("없는 주소입니다", 404)
            return self.serve_static(path)
        except (ValueError, KeyError) as e:
            return self.fail(f"요청 형식 오류: {e}")
        except Exception as e:  # noqa: BLE001 - 화면에는 종류만 알림
            print(f"[오류] {type(e).__name__}", file=sys.stderr)
            return self.fail("처리 중 오류가 발생했습니다", 500)

    def serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        elif path == "/report":
            path = "/report.html"
        full = os.path.realpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self.fail("없는 주소입니다", 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".wasm"):
            ctype = "application/wasm"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache" if "/vendor/" not in full.replace("\\", "/") else "max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------------- API

    def route_api(self, method, p):
        s = self.app.store
        if p == "ping":
            return self.send_json({"app": APP_ID, "online": ONLINE})
        if p == "cron":
            # 온라인판 자료 갱신: 1시간이 지났을 때만 실제로 받음 (누가 불러도 그 이상 자주 받지 않음)
            r = self.app.food.refresh_if_stale()
            return self.send_json({**r, "fetched_at": self.app.food.status()["fetched_at"]})
        if method == "POST" and p == "signup":
            return self.api_signup()
        if method == "POST" and p == "login":
            return self.api_login()
        if method == "POST" and p == "logout":
            s.drop_session(self.token())
            return self.send_json({"ok": True}, headers={"Set-Cookie": self.cookie("", 0)})
        if ONLINE:
            self.app.food.sync_from_store()

        u = self.user()
        if p == "me" and method == "GET":
            if not u:
                return self.send_json({"user": None})
            return self.send_json({"user": u, "unit": unit_codes().get(u["unit_code"], {}),
                                   "managers": s.managers(u["unit_code"]), "categories": categories()["categories"],
                                   "defect_types": DEFECT_TYPES, "visual_types": VISUAL_TYPES})
        if not u:
            return self.fail("로그인이 필요합니다", 401)
        unit = u["unit_code"]
        food = self.app.food

        if p == "status" and method == "GET":
            return self.send_json(food.status())
        if p == "refresh" and method == "POST":
            ok = food.refresh(wait=True)
            return self.send_json({"ok": ok, "status": food.status()})
        if p == "banner" and method == "GET":
            return self.send_json({"items": food.banner()})
        if p == "notices" and method == "GET":
            rows = food.notices(self.query.get("source", "all"), self.query.get("grade", "all"))
            size = max(1, min(50, int(self.query.get("size", 5))))
            page = max(1, int(self.query.get("page", 1)))
            return self.send_json({"total": len(rows), "page": page, "size": size,
                                   "items": rows[(page - 1) * size: page * size]})
        if p == "search" and method == "GET":
            rows = food.search(self.query.get("barcode", ""), self.query.get("q", ""), self.query.get("company", ""))
            return self.send_json({"items": rows[:200], "total": len(rows)})
        if p == "vendors" and method == "GET":
            return self.send_json({"items": s.vendors(unit)})
        if p == "settings" and method == "PUT":
            return self.api_settings(u)
        if p == "export.csv" and method == "GET":
            return self.api_csv(unit)
        if p == "image" and method == "GET":
            return self.api_image()

        if p == "inspections":
            if method == "GET":
                return self.send_json({"items": s.inspections(unit)})
            if method == "POST":
                b = self.body_json()
                vendor = (b.get("vendor") or "").strip()
                if not vendor:
                    return self.fail("납품업체를 입력하세요")
                cur = s.current_inspection(u["id"])
                if cur:
                    s.close_inspection(cur["id"])
                iid = s.create_inspection(u, vendor[:100])
                return self.send_json(self.inspection_payload(iid, unit, u))
        if p == "inspections/current" and method == "GET":
            cur = s.current_inspection(u["id"])
            return self.send_json(self.inspection_payload(cur["id"], unit, u) if cur else {"inspection": None})

        m = re.fullmatch(r"inspections/(\d+)(/[a-z]+)?", p)
        if m:
            iid = int(m.group(1))
            insp = s.inspection(iid, unit)
            if not insp:
                return self.fail("검수 회차를 찾을 수 없습니다", 404)
            sub = m.group(2) or ""
            if sub == "" and method == "GET":
                return self.send_json(self.inspection_payload(iid, unit, u))
            if sub == "" and method == "PUT":
                vendor = (self.body_json().get("vendor") or "").strip()
                if not vendor:
                    return self.fail("납품업체를 입력하세요")
                s.set_vendor(iid, vendor[:100])
                return self.send_json(self.inspection_payload(iid, unit, u))
            if sub == "/items" and method == "POST":
                return self.api_add_item(insp)
            if sub == "/close" and method == "POST":
                s.close_inspection(iid)
                return self.send_json({"ok": True})
            if sub == "/reported" and method == "POST":
                s.mark_reported(iid)
                return self.send_json(self.inspection_payload(iid, unit, u))
            if sub == "/report" and method == "GET":
                issues = [i for i in s.items(iid) if i["result"] == "issue"]
                when = insp["reported_at"] if (self.query.get("at") == "reported" and insp["reported_at"]) \
                    else datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                return self.send_json({"text": report_text(unit, insp["author"], insp, issues, when),
                                       "count": len(issues), "managers": s.managers(unit)})

        m = re.fullmatch(r"items/(\d+)(/photo)?", p)
        if m:
            item = s.item(int(m.group(1)), unit)
            if not item:
                return self.fail("품목을 찾을 수 없습니다", 404)
            if m.group(2):
                return self.api_photo(method, item)
            if method == "PUT":
                return self.api_update_item(item)
            if method == "DELETE":
                if item["photo_path"]:
                    s.photo_delete(item)
                s.delete_item(item["id"])
                return self.send_json({"ok": True})
        return self.fail("없는 주소입니다", 404)

    def inspection_payload(self, iid, unit, u):
        s = self.app.store
        insp = s.inspection(iid, unit)
        return {"inspection": insp, "items": [item_view(i) for i in s.items(iid)],
                "unit_code": unit, "unit": unit_codes().get(unit, {}), "managers": s.managers(unit)}

    def api_signup(self):
        b = self.body_json()
        username = (b.get("username") or "").strip()
        pw = b.get("password") or ""
        rank = (b.get("rank") or "").strip()
        name = (b.get("name") or "").strip()
        code = (b.get("unit_code") or "").strip().upper()
        if not re.fullmatch(r"[A-Za-z0-9_.\-]{3,30}", username):
            return self.fail("아이디는 영문·숫자 3~30자로 입력하세요")
        if len(pw) < 8:
            return self.fail("비밀번호는 8자 이상으로 입력하세요")
        if not rank or not name:
            return self.fail("계급과 성명을 입력하세요")
        if code not in unit_codes():
            return self.fail("등록되지 않은 부대 코드입니다")
        if self.app.store.user_by_name(username):
            return self.fail("이미 있는 아이디입니다")
        uid = self.app.store.create_user(username, pw, rank[:20], name[:30], code)
        return self.login_ok(uid)

    def api_login(self):
        b = self.body_json()
        u = self.app.store.user_by_name((b.get("username") or "").strip())
        if not u or not check_password(b.get("password") or "", u["pw_hash"]):
            return self.fail("아이디 또는 비밀번호가 맞지 않습니다", 401)
        return self.login_ok(u["id"])

    def login_ok(self, uid):
        token = self.app.store.new_session(uid)
        return self.send_json({"ok": True}, headers={"Set-Cookie": self.cookie(token, 60 * 60 * 24 * 30)})

    def api_settings(self, u):
        b = self.body_json()
        rank = (b.get("rank") or u["rank"]).strip()[:20]
        name = (b.get("name") or u["name"]).strip()[:30]
        self.app.store.update_user(u["id"], rank, name)
        managers = []
        for m in (b.get("managers") or [])[:3]:
            row = {k: str(m.get(k) or "").strip()[:40] for k in ("role", "name", "phone")}
            if any(row.values()):
                managers.append(row)
        self.app.store.set_managers(u["unit_code"], managers)
        return self.send_json({"ok": True})

    def api_add_item(self, insp):
        b = self.body_json()
        result = b.get("result")
        if result not in ("pass", "issue"):
            return self.fail("결과 값이 올바르지 않습니다")
        basis = b.get("basis") if b.get("basis") in ("I0490", "I2620", "I2715", "visual") else ""
        data = {k: str(b.get(k) or "")[:500] for k in
                ("name", "barcode", "method", "match", "source_seq", "grade", "defect_type", "maker",
                 "mfg_date", "exp_date", "qty", "unit", "memo")}
        data.update(result=result, basis=basis)
        if data["method"] not in METHOD_LABEL:
            data["method"] = "manual"
        if data["match"] not in MATCH_LABEL:
            data["match"] = ""
        detail = b.get("detail") if isinstance(b.get("detail"), dict) else {}
        data["detail"] = json.dumps(detail, ensure_ascii=False)[:20000]
        if result == "issue":
            if basis in BASIS_DEFECT:
                data["defect_type"] = BASIS_DEFECT[basis]
            elif data["defect_type"] not in VISUAL_TYPES:
                data["defect_type"] = "기타"
            data["suggested"] = suggest(basis or "visual", data["grade"])
            data["final"] = data["suggested"]
            if insp["reported"]:
                self.app.store.unmark_reported(insp["id"])
        iid = self.app.store.add_item(insp["id"], data)
        return self.send_json({"id": iid})

    def api_update_item(self, item):
        b = self.body_json()
        fields = {}
        for k in ITEM_EDITABLE:
            if k in b:
                fields[k] = str(b[k] or "")[:500]
        if "defect_type" in fields and fields["defect_type"] not in DEFECT_TYPES:
            fields.pop("defect_type")
        if "final" in fields:
            if fields["final"] not in categories()["categories"]:
                fields.pop("final")
            else:
                fields["modified"] = int(fields["final"] != item["suggested"])
        self.app.store.update_item(item["id"], fields)
        return self.send_json(item_view(self.app.store.item(item["id"], self.user()["unit_code"])))

    def api_photo(self, method, item):
        s = self.app.store
        if method == "GET":
            got = s.photo_get(item) if item["photo_path"] else None
            if not got:
                return self.fail("사진이 없습니다", 404)
            data, ctype = got
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        if method == "POST":
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
            ext = PHOTO_TYPES.get(ctype)
            if not ext:
                return self.fail("JPG·PNG·WEBP 사진만 올릴 수 있습니다")
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= MAX_PHOTO:
                return self.fail(f"사진은 {MAX_PHOTO // 1_000_000}MB 이하만 올릴 수 있습니다")
            s.photo_put(item, self.rfile.read(n), ctype, ext)
            return self.send_json({"ok": True})
        if method == "DELETE":
            if item["photo_path"]:
                s.photo_delete(item)
            return self.send_json({"ok": True})
        return self.fail("없는 주소입니다", 404)

    def send_bytes(self, data, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def api_image(self):
        """식품안전나라 제품 사진. 한 번 받은 사진은 PC에 보관해 인터넷이 끊겨도 보이게 함."""
        svc = self.query.get("src", "")
        seq = self.query.get("seq", "")
        i = int(self.query.get("i", 0))
        if svc not in ("I0490", "I2715") or not re.fullmatch(r"[\w\-]{1,40}", seq) or not 0 <= i < 5:
            return self.fail("사진이 없습니다", 404)
        if ONLINE:
            # 원본 사진이 수 MB라 Vercel 응답 한도(4.5MB)를 넘을 수 있음 → 브라우저가 식품안전나라에서 바로 받게 함
            url = self.app.food.image_url(svc, seq, i)
            if not url:
                return self.fail("사진이 없습니다", 404)
            self.send_response(302)
            self.send_header("Location", url)
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        folder = os.path.join(DATA, "img_cache")
        base = os.path.join(folder, f"{svc}_{seq}_{i}")
        for ext, ctype in IMAGE_EXT.items():
            if os.path.isfile(base + ext):
                with open(base + ext, "rb") as f:
                    return self.send_bytes(f.read(), ctype)
        url = self.app.food.image_url(svc, seq, i)
        if not url:
            return self.fail("사진이 없습니다", 404)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = r.read(MAX_IMAGE + 1)
        except Exception:  # noqa: BLE001 - 연결 실패·404 등은 사진 없음으로
            return self.fail("사진을 받지 못했습니다", 404)
        ext = sniff_image(data)  # 서버가 형식을 잘못 알려 주는 경우가 있어 내용으로 판단
        if not ext or len(data) > MAX_IMAGE:
            return self.fail("사진 형식이 아닙니다", 404)
        ctype = IMAGE_EXT[ext]
        os.makedirs(folder, exist_ok=True)
        with open(base + ext, "wb") as f:
            f.write(data)
        return self.send_bytes(data, ctype)

    def api_csv(self, unit):
        rows = self.app.store.all_items(unit)
        if self.query.get("inspection"):
            rows = [r for r in rows if str(r["inspection_id"]) == self.query["inspection"]]
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["회차", "검수 일시", "납품업체", "작성자", "품목명", "바코드", "확인 방법", "결과", "후보 대조",
                    "근거", "등급", "불량 유형", "제조사", "제조일자", "소비기한", "수량", "단위", "앱 제안 분류",
                    "최종 분류", "감독관 수정", "메모", "보고 여부", "보고 시각", "기록 시각"])
        for r in rows:
            w.writerow([r["inspection_id"], r["started_at"], r["vendor"], r["author"], r["name"], r["barcode"],
                        METHOD_LABEL.get(r["method"], r["method"]), "통과" if r["result"] == "pass" else "이상",
                        MATCH_LABEL.get(r["match"], r["match"]), BASIS_LABEL.get(r["basis"], r["basis"]), r["grade"],
                        r["defect_type"], r["maker"], r["mfg_date"], r["exp_date"], r["qty"], r["unit"],
                        r["suggested"], r["final"], "예" if r["modified"] else "", r["memo"],
                        "예" if r["reported"] else "아니오", r["reported_at"] or "", r["created_at"]])
        body = ("﻿" + out.getvalue()).encode("utf-8")
        name = f"검수기록_{unit}_{datetime.now():%Y%m%d_%H%M}.csv"
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{urllib.request.quote(name)}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def probe(port):
    """'ours' = 이미 켜진 이 프로그램, 'free' = 비어 있음, 'other' = 다른 프로그램이 씀"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=0.7) as r:
            return "ours" if json.loads(r.read().decode("utf-8")).get("app") == APP_ID else "other"
    except urllib.error.URLError as e:
        return "free" if isinstance(e.reason, ConnectionRefusedError) else "other"
    except Exception:  # noqa: BLE001
        return "other"


def main():
    no_browser = "--no-browser" in sys.argv
    for port in PORTS:
        found = probe(port)
        if found == "ours":
            print(f"이미 켜져 있습니다: http://localhost:{port}")
            if not no_browser:
                webbrowser.open(f"http://localhost:{port}")
            return
        if found == "free":
            break
    app = App()
    Handler.app = app
    server = None
    for port in PORTS:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if not server:
        print("사용할 수 있는 포트가 없습니다 (8765~8775)")
        sys.exit(1)
    server.daemon_threads = True
    port = server.server_address[1]
    app.food.start_auto_refresh()
    url = f"http://localhost:{port}"
    print("군 급식 식자재 안전 지키미 (베타)")
    print(f"주소: {url}  (이 창을 닫으면 프로그램이 꺼집니다)")
    if not no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
