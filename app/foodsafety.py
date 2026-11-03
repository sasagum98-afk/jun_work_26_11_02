"""식품안전나라 자료 받기·PC 저장본 보관·검색.

- I0490 회수·판매중지, I2620 검사부적합(국내), I2715 해외직구 위해식품(보조)
- I2640은 I2620에 모두 포함되어 받지 않음 (PRD 5-1-1)
- 인증키는 이 모듈 밖으로 나가지 않으며, 오류 문구에서도 지움
"""
import json
import re
import socket
import threading
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

SERVICES = ["I0490", "I2620", "I2715"]
SERVICE_LABEL = {
    "I0490": "I0490 회수·판매중지",
    "I2620": "I2620 검사부적합(국내)",
    "I2715": "I2715 해외직구 위해식품(보조)",
}
PAGE = 1000  # 1회 최대 1000건 (ERROR-336)
MAX_ROWS = 50000
REFRESH_SECONDS = 3600
EMPTY_VALUES = {"", "데이터없음", "null", "none", "-"}


def clean(v):
    if v is None:
        return ""
    s = str(v).strip()
    return "" if s.lower() in EMPTY_VALUES else s


# ---------------------------------------------------------------- 날짜 변환

_DATE_PATTERNS = [
    re.compile(r"(?<!\d)(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?!\d)"),
    re.compile(r"(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)"),
    re.compile(r"(?<![\d.])(\d{2})\.(\d{1,2})\.(\d{1,2})(?![\d])"),
]
_NOTE_WORDS = ["수거일자", "수거일", "의뢰일자", "의뢰일", "검사일", "채취일"]


def _make_date(y, m, d):
    if y < 100:
        y += 2000
    if not 1990 <= y <= 2100:
        return None
    try:
        return date(y, m, d)
    except ValueError:
        return None


def parse_dates(raw):
    """표기가 제각각인 날짜 문자열을 숫자 날짜로 바꿈. 못 바꾸면 원문 그대로."""
    s = clean(raw)
    note = next((w for w in _NOTE_WORDS if w in s), "")
    if not s:
        return {"raw": "", "text": "", "ok": False, "note": ""}
    hits = []
    taken = []
    for pat in _DATE_PATTERNS:
        for m in pat.finditer(s):
            if any(a < m.end() and m.start() < b for a, b in taken):
                continue
            d = _make_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if d:
                hits.append((m.start(), d))
                taken.append((m.start(), m.end()))
    hits.sort()
    dates = []
    for _, d in hits:
        iso = d.isoformat()
        if iso not in dates:
            dates.append(iso)
    if not dates:
        return {"raw": s, "text": s, "ok": False, "note": note}
    return {"raw": s, "text": ", ".join(dates), "ok": True, "note": note}


def first_date(raw):
    p = parse_dates(raw)
    return p["text"].split(", ")[0] if p["ok"] else ""


# ---------------------------------------------------------------- 자료 정리

def norm_text(s):
    return re.sub(r"[\s()\[\]{}·,./_\-~'\"]+", "", s or "").lower()


def _barcodes(v):
    return [b for b in re.split(r"[^0-9]+", clean(v)) if len(b) >= 6]


IMAGE_HOST = "https://www.foodsafetykorea.go.kr"


def _images(v):
    """제품 사진 주소. 여러 장이면 쉼표 등으로 이어져 있음. 상대 경로는 식품안전나라 주소를 붙임."""
    out = []
    for part in re.split(r"[,\s|]+", clean(v)):
        if not part:
            continue
        if part.startswith("/"):
            part = IMAGE_HOST + part
        if re.match(r"https?://", part, re.I) and part not in out:
            out.append(part)
    return out[:5]


def grade_rank(rec):
    """정렬 순서: 1등급 → 2등급 → 3등급 → 부적합·등급 없음 → 해외직구"""
    if rec["source"] == "I0490":
        g = rec["grade"]
        for n, r in (("1", 0), ("2", 1), ("3", 2)):
            if n in g:
                return r
        return 3
    if rec["source"] == "I2620":
        return 3
    return 4


def normalize(svc, r):
    if svc == "I2715":
        rec = {
            "source": svc,
            "seq": clean(r.get("SELF_IMPORT_SEQ")),
            "name": clean(r.get("PRDT_NM")),
            "company": clean(r.get("MUFC_NM")),
            "country": clean(r.get("MUFC_CNTRY_NM")),
            "barcodes": _barcodes(r.get("BARCD_CTN")),
            "grade": "",
            "reason": clean(r.get("INGR_NM_LST")),
            "food_type": "",
            "pack_unit": "",
            "mfg": parse_dates(""),
            "exp": parse_dates(""),
            "created_raw": clean(r.get("CRET_DTM")),
            "_images": _images(r.get("IMAGE_URL")),
        }
    else:
        rec = {
            "source": svc,
            "seq": clean(r.get("RTRVLDSUSE_SEQ")),
            "name": clean(r.get("PRDTNM")),
            "company": clean(r.get("BSSHNM")),
            "country": "",
            "barcodes": _barcodes(r.get("BRCDNO")),
            "grade": clean(r.get("RTRVL_GRDCD_NM")) if svc == "I0490" else "",
            "reason": clean(r.get("RTRVLPRVNS")) if svc == "I0490" else "",
            "food_type": clean(r.get("PRDLST_CD_NM")),
            "pack_unit": clean(r.get("FRMLCUNIT")),
            "mfg": parse_dates(r.get("MNFDT")),
            "exp": parse_dates(r.get("DISTBTMLMT")),
            "created_raw": clean(r.get("CRET_DTM")),
            "_images": _images(r.get("IMG_FILE_PATH")) if svc == "I0490" else [],
        }
        if svc == "I2620":
            rec["test_item"] = clean(r.get("TEST_ITMNM"))
            rec["standard"] = clean(r.get("STDR_STND"))
            rec["test_result"] = clean(r.get("TESTANALS_RSLT"))
    rec["image_count"] = len(rec["_images"])
    rec["created"] = first_date(rec["created_raw"])
    rec["id"] = f"{svc}:{rec['seq'] or id(r)}"
    rec["rank"] = grade_rank(rec)
    rec["_name_n"] = norm_text(rec["name"])
    rec["_company_n"] = norm_text(rec["company"])
    return rec


def public(rec):
    return {k: v for k, v in rec.items() if not k.startswith("_")}


# ---------------------------------------------------------------- 받기

class ApiError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind  # key / api / offline / format
        self.message = message


def fetch_service(base, key, svc):
    rows = []
    start = 1
    while start <= MAX_ROWS:
        end = start + PAGE - 1
        url = f"{base}/{key}/{svc}/json/{start}/{end}"
        try:
            with urllib.request.urlopen(url, timeout=25) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError):
            raise ApiError("offline", "인터넷 연결 실패")
        except ValueError:
            raise ApiError("format", f"{svc} 응답 형식 오류")
        body = data.get(svc) if isinstance(data.get(svc), dict) else data
        result = body.get("RESULT") or {}
        code = str(result.get("CODE", ""))
        if code == "INFO-200":  # 해당 자료 없음
            break
        if code == "INFO-100":
            raise ApiError("key", "인증키 확인 필요")
        if code and code != "INFO-000":
            raise ApiError("api", f"{svc} 자료 받기 실패({code} {clean(result.get('MSG'))})")
        batch = body.get("row") or []
        rows.extend(batch)
        try:
            total = int(body.get("total_count") or 0)
        except ValueError:
            total = 0
        if not batch or end >= total:
            break
        start = end + 1
    return rows


class FoodData:
    """PC 저장본(SQLite cache 표)을 메모리에 올려 두고 검색. 1시간마다 새로 받음."""

    def __init__(self, store, env):
        self.store = store
        self.key = env.get("FOODSAFETY_KEY", "").strip()
        self.base = env.get("FOODSAFETY_BASE_URL", "https://openapi.foodsafetykorea.go.kr/api").rstrip("/")
        self.lock = threading.Lock()
        self.refreshing = threading.Lock()
        self.records = {s: [] for s in SERVICES}
        self.by_barcode = {}
        self.by_id = {}
        self.fetched_at = {s: "" for s in SERVICES}
        self.last_attempt = ""
        self.error_kind = ""
        self.error_msg = ""
        self._load_cache()

    # -- 저장본

    def _load_cache(self):
        for svc in SERVICES:
            row = self.store.cache_get(svc)
            if row:
                try:
                    self._set_rows(svc, json.loads(row["data"]), row["fetched_at"])
                except ValueError:
                    pass

    def _set_rows(self, svc, rows, fetched_at):
        recs = [normalize(svc, r) for r in rows]
        with self.lock:
            self.records[svc] = recs
            self.fetched_at[svc] = fetched_at
            idx = {}
            ids = {}
            for s in SERVICES:
                for rec in self.records[s]:
                    ids[rec["id"]] = rec
                    for b in rec["barcodes"]:
                        idx.setdefault(b, []).append(rec)
            self.by_barcode = idx
            self.by_id = ids

    def _safe(self, msg):
        return msg.replace(self.key, "***") if self.key else msg

    # -- 받기

    def refresh(self, wait=False):
        if not self.refreshing.acquire(blocking=wait):
            return False
        try:
            self.last_attempt = now_str()
            if not self.key:
                self.error_kind, self.error_msg = "key", "인증키 확인 필요 (.env 파일에 FOODSAFETY_KEY가 없습니다)"
                return False
            errors = []
            for svc in SERVICES:
                try:
                    rows = fetch_service(self.base, self.key, svc)
                except ApiError as e:
                    errors.append(e)
                    if e.kind in ("offline", "key"):
                        break
                    continue
                except Exception as e:  # 예상 못 한 오류도 키를 지우고 기록
                    errors.append(ApiError("api", self._safe(f"{svc} 자료 받기 실패({type(e).__name__})")))
                    continue
                stamp = now_str()
                self.store.cache_put(svc, stamp, json.dumps(rows, ensure_ascii=False))
                self._set_rows(svc, rows, stamp)
            if errors:
                e = errors[0]
                self.error_kind, self.error_msg = e.kind, self._safe(e.message)
            else:
                self.error_kind, self.error_msg = "", ""
            return not errors
        finally:
            self.refreshing.release()

    def start_auto_refresh(self):
        def loop():
            stop = threading.Event()
            while True:
                self.refresh()
                stop.wait(REFRESH_SECONDS)
        threading.Thread(target=loop, daemon=True).start()

    # -- 조회

    def status(self):
        with self.lock:
            stamps = [self.fetched_at[s] for s in SERVICES if self.fetched_at[s]]
            i2620 = [r["created"] for r in self.records["I2620"] if r["created"]]
            counts = {s: len(self.records[s]) for s in SERVICES}
            per = {s: self.fetched_at[s] for s in SERVICES}
        return {
            "fetched_at": min(stamps) if len(stamps) == len(SERVICES) else (min(stamps) if stamps else ""),
            "per_service": per,
            "counts": counts,
            "labels": SERVICE_LABEL,
            "last_attempt": self.last_attempt,
            "refreshing": self.refreshing.locked(),
            "error_kind": self.error_kind,
            "error_msg": self.error_msg,
            "i2620_since": min(i2620)[:7] if i2620 else "",
            "refresh_minutes": REFRESH_SECONDS // 60,
        }

    def image_url(self, svc, seq, i):
        """저장본에 있는 제품의 사진 주소만 내줌 (아무 주소나 받아 오는 통로가 되지 않게)"""
        with self.lock:
            rec = self.by_id.get(f"{svc}:{seq}")
            if rec and 0 <= i < len(rec["_images"]):
                return rec["_images"][i]
        return ""

    def banner(self, days=30):
        cutoff = (date.today() - timedelta(days=days)).isoformat()
        with self.lock:
            hits = [r for r in self.records["I0490"] if r["rank"] == 0 and r["created"] and r["created"] >= cutoff]
        hits.sort(key=lambda r: r["created"], reverse=True)
        return [public(r) for r in hits]

    def notices(self, source="all", grade="all"):
        with self.lock:
            recs = []
            if source in ("all", "recall"):
                recs += self.records["I0490"]
            if source in ("all", "unfit") and grade == "all":
                recs += self.records["I2620"]
        if grade != "all":
            recs = [r for r in recs if r["source"] == "I0490" and grade in r["grade"]]
        recs = sorted(recs, key=lambda r: (r["created"], r["created_raw"]), reverse=True)
        return [public(r) for r in recs]

    def search(self, barcode="", q="", company=""):
        found = {}
        bc = re.sub(r"\D", "", barcode or "")
        qn = norm_text(q)
        cn = norm_text(company)
        with self.lock:
            if bc:
                # UPC-A(12자리)와 앞에 0이 붙은 EAN-13은 같은 바코드
                variants = {bc}
                if len(bc) == 13 and bc.startswith("0"):
                    variants.add(bc[1:])
                if len(bc) == 12:
                    variants.add("0" + bc)
                for v in variants:
                    for rec in self.by_barcode.get(v, []):
                        found[rec["id"]] = (rec, "바코드 일치")
            if qn:
                for svc in SERVICES:
                    for rec in self.records[svc]:
                        n = rec["_name_n"]
                        if not n:
                            continue
                        if qn in n or (len(n) >= 2 and n in qn):
                            found.setdefault(rec["id"], (rec, "품목명 일치"))
        out = []
        for rec, why in found.values():
            item = public(rec)
            item["match_by"] = why
            item["company_match"] = bool(cn and rec["_company_n"] and (cn in rec["_company_n"] or rec["_company_n"] in cn))
            out.append(item)
        # 1등급부터, 같은 순위 안에서는 업체명 일치 → 최신순 (안정 정렬 두 번)
        out.sort(key=lambda r: r["created"] or "", reverse=True)
        out.sort(key=lambda r: (r["rank"], not r["company_match"]))
        return out


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M")
