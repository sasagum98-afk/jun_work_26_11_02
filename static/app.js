/* 군 급식 식자재 안전 지키미 (베타) - 화면 */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const SRC_LABEL = {
  I0490: "I0490 회수·판매중지",
  I2620: "I2620 검사부적합(국내·농산물 포함)",
  I2715: "I2715 해외직구 위해식품(보조)",
};
const CAND_TITLE = { I0490: "회수 대상 후보", I2620: "검사부적합 후보", I2715: "해외직구 위해식품 후보(보조)" };
const METHOD_LABEL = { barcode: "바코드", ocr: "글자 인식", manual: "입력" };
const MATCH_LABEL = { none: "후보 없음", lot_match: "로트 일치", lot_mismatch: "후보 있었으나 로트 불일치" };
const BASIS_LABEL = { I0490: "I0490 회수", I2620: "I2620 부적합", I2715: "I2715 해외직구", visual: "육안" };
const UNITS = ["kg", "g", "박스", "개", "봉", "팩", "캔", "병", "L", "망", "포대", "단"];
const RANKS = ["하사", "중사", "상사", "원사", "준위", "소위", "중위", "대위", "소령", "중령", "대령", "군무원"];
const CAND_PAGE = 5;
const VENDOR_NONE = "납품업체 미입력";

const state = {
  me: null,
  status: null,
  banner: [],
  bannerOpen: false,
  current: null, // { inspection, items, ... }
  method: "barcode",
  pendingVendor: "",
  search: null, // { method, barcode, q, company, items, page }
  notice: { source: "all", grade: "all", size: 5, page: 1 },
  records: { openId: null },
};

/* ------------------------------------------------------------ 공통 */

async function api(method, path, body, raw) {
  const opt = { method, headers: {} };
  if (raw) {
    opt.body = raw;
    opt.headers["Content-Type"] = raw.type || "application/octet-stream";
  } else if (body !== undefined) {
    opt.body = JSON.stringify(body);
    opt.headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch("/api/" + path, opt);
  } catch {
    throw new Error("프로그램과 연결되지 않습니다. 실행.cmd 창이 켜져 있는지 확인하세요.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "login") {
    state.me = null;
    render();
    throw new Error(data.error || "로그인이 필요합니다");
  }
  if (!res.ok) throw new Error(data.error || "처리하지 못했습니다");
  return data;
}

let toastTimer;
function toast(msg) {
  let t = $(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

/* ------------------------------------------------------------ 읽어 주기·말로 입력 */

function prefGet(k, def) {
  try {
    const v = localStorage.getItem(k);
    return v === null ? def : v === "1";
  } catch { return def; }
}
function prefSet(k, v) {
  try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* 저장 못 해도 동작 */ }
}

const TTS_OK = "speechSynthesis" in window;
let warnedVoice = false;
function speak(text) {
  if (!TTS_OK) return toast("이 브라우저는 읽어 주기를 지원하지 않습니다.");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  u.rate = 0.95;
  const voice = speechSynthesis.getVoices().find((v) => /^ko/i.test(v.lang));
  if (voice) u.voice = voice;
  else if (!warnedVoice && speechSynthesis.getVoices().length) {
    warnedVoice = true;
    toast("한국어 음성이 없습니다. Windows 설정 > 시간 및 언어 > 음성에서 한국어 음성을 추가하세요.");
  }
  speechSynthesis.speak(u);
}
function stopSpeak() {
  if (TTS_OK) speechSynthesis.cancel();
}

function sayDate(d) {
  if (!d || !d.raw) return "자료에 없음";
  if (!d.ok) return d.raw;
  return d.text.split(", ").map((t) => {
    const [y, m, dd] = t.split("-").map(Number);
    return `${y}년 ${m}월 ${dd}일`;
  }).join(", ") + (d.note ? `, ${d.note} 표시` : "");
}

function sayable(s) {
  return String(s || "").replace(/\s\/\s/g, ", ").replace(/mg\/kg/g, "밀리그램 퍼 킬로그램").replace(/\*/g, " ");
}

function candidateSpeech(r) {
  const g1 = r.source === "I0490" && (r.grade || "").includes("1");
  const parts = [];
  if (g1) parts.push("주의. 급식에 쓰지 마세요.");
  parts.push(`${r.source === "I0490" ? r.grade || "등급 없음" : ""} ${CAND_TITLE[r.source]}.`);
  parts.push(`제품명 ${r.name}.`);
  if (r.company) parts.push(`업체 ${r.company}.`);
  if (r.source !== "I2715") parts.push(`제조일자 ${sayDate(r.mfg)}. 소비기한 ${sayDate(r.exp)}.`);
  if (r.reason) parts.push(`${r.source === "I2715" ? "문제 성분" : "회수 사유"} ${r.reason}.`);
  if (r.test_item) parts.push(`부적합 항목 ${r.test_item}. 검사결과 ${r.test_result || ""}.`);
  parts.push(r.source === "I2715" ? "제품명과 제조사를 실물과 대조하세요." : "실물 포장의 날짜와 같은지 확인하세요.");
  return sayable(parts.join(" "));
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const KO_DIGIT = { 공: "0", 영: "0", 빵: "0", 일: "1", 이: "2", 삼: "3", 사: "4", 오: "5", 육: "6", 륙: "6", 칠: "7", 팔: "8", 구: "9" };
const MIC_ERR = {
  "not-allowed": "마이크 사용이 막혀 있습니다. 주소창 왼쪽 아이콘에서 마이크를 허용하세요.",
  "service-not-allowed": "마이크 사용이 막혀 있습니다.",
  network: "말로 입력은 인터넷 연결이 필요합니다.",
  "no-speech": "말소리가 들리지 않았습니다. 다시 눌러 말해 주세요.",
  "audio-capture": "마이크를 찾을 수 없습니다.",
};
let listening = null;

function micBtn(targetId, digits) {
  return `<button type="button" class="btn mic" data-mic="${targetId}" ${digits ? 'data-digits="1"' : ""} aria-label="말로 입력"
    ${SR ? 'title="말로 입력"' : 'disabled title="이 브라우저는 말로 입력을 지원하지 않습니다 (Chrome·Edge 사용)"'}>음성</button>`;
}

function withMic(inputHtml, targetId, digits) {
  return `<div class="with-mic">${inputHtml}${micBtn(targetId, digits)}</div>`;
}

function bindMics(root = document) {
  $$("[data-mic]", root).forEach((b) => (b.onclick = () => listen(b)));
}

function listen(btn) {
  if (!SR) return toast("이 브라우저는 말로 입력을 지원하지 않습니다. Chrome이나 Edge를 쓰세요.");
  if (listening) {
    listening.stop();
    return;
  }
  if (!prefGet("micAgreed", false)) {
    const ok = confirm("말로 입력하면 음성이 브라우저 회사(구글·마이크로소프트)의 서버로 보내져 글자로 바뀝니다. 인터넷이 필요합니다.\n\n부대명·수량 등 민감한 내용은 말하지 마세요. 계속할까요?");
    if (!ok) return;
    prefSet("micAgreed", true);
  }
  const input = document.getElementById(btn.dataset.mic);
  if (!input) return;
  stopSpeak();
  const r = new SR();
  r.lang = "ko-KR";
  r.interimResults = true;
  r.maxAlternatives = 1;
  listening = r;
  btn.classList.add("on");
  btn.textContent = "듣는 중";
  toast("말씀하세요. 다시 누르면 멈춥니다.");
  r.onresult = (e) => {
    let t = "";
    for (const res of e.results) t += res[0].transcript;
    input.value = btn.dataset.digits ? [...t].map((c) => KO_DIGIT[c] || c).join("").replace(/\D/g, "") : t.trim();
  };
  r.onerror = (e) => toast(MIC_ERR[e.error] || "말을 알아듣지 못했습니다. 다시 해 보세요.");
  r.onend = () => {
    listening = null;
    btn.classList.remove("on");
    btn.textContent = "음성";
    input.focus();
  };
  try { r.start(); } catch { r.onend(); }
}

function gradeBadge(rec) {
  if (rec.source !== "I0490") return "";
  const g = rec.grade || "";
  if (g.includes("1")) return `<span class="badge g1">1등급</span>`;
  if (g.includes("2")) return `<span class="badge g2">2등급</span>`;
  if (g.includes("3")) return `<span class="badge g3">3등급</span>`;
  return `<span class="badge src">${esc(g || "등급 없음")}</span>`;
}

function catBadge(cat) {
  return `<span class="badge ${cat === "급식중단" ? "cat-stop" : "cat"}">${esc(cat)}</span>`;
}

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}(${"일월화수목금토"[d.getDay()]})`;
}

function pager(total, page, size, attr) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return "";
  let from = Math.max(1, page - 3);
  const to = Math.min(pages, from + 6);
  from = Math.max(1, to - 6);
  let h = `<div class="pager" role="navigation" aria-label="쪽 이동">`;
  h += `<button class="btn small" ${attr}="${page - 1}" ${page <= 1 ? "disabled" : ""}>이전</button>`;
  for (let i = from; i <= to; i++) {
    h += `<button class="btn small ${i === page ? "on" : ""}" ${attr}="${i}" ${i === page ? 'aria-current="page"' : ""}>${i}</button>`;
  }
  h += `<button class="btn small" ${attr}="${page + 1}" ${page >= pages ? "disabled" : ""}>다음</button>`;
  return h + `<span class="muted small">${page} / ${pages}쪽</span></div>`;
}

function statusText(st) {
  if (!st) return "";
  const parts = [];
  const last = st.fetched_at;
  if (st.error_kind === "offline") {
    parts.push(`<span class="bad">인터넷 연결 실패 – ${last ? `마지막 자료(${esc(last)}) 사용 중` : "받은 자료가 없습니다"}</span>`);
  } else if (st.error_kind) {
    parts.push(`<span class="bad">${esc(st.error_msg)}${last ? ` – 마지막 자료(${esc(last)}) 사용 중` : " – 받은 자료가 없습니다"}</span>`);
  } else if (last) {
    parts.push(`<span>자료 받은 시각 <b>${esc(last)}</b> (${st.refresh_minutes / 60}시간마다 자동 갱신)</span>`);
  } else {
    parts.push(`<span>자료를 아직 받지 않았습니다</span>`);
  }
  if (st.refreshing) parts.push(`<span class="progress">자료 받는 중…</span>`);
  if (st.i2620_since) parts.push(`<span>부적합 자료는 ${esc(st.i2620_since)} 이후 등록분</span>`);
  return parts.join("");
}

/* ------------------------------------------------------------ 시작·이동 */

async function boot() {
  try {
    const r = await api("GET", "me");
    state.me = r.user ? r : null;
  } catch (e) {
    $("#main").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  window.addEventListener("hashchange", render);
  render();
  pollStatus();
}

function view() {
  return (location.hash.slice(1) || "inspect").split("/")[0];
}

function render() {
  stopCamera();
  stopSpeak();
  if (listening) listening.stop();
  const nav = $("#nav");
  const who = $("#who");
  if (!state.me) {
    nav.classList.add("hidden");
    who.classList.add("hidden");
    $("#topart").classList.add("hidden");
    return renderAuth();
  }
  nav.classList.remove("hidden");
  who.classList.remove("hidden");
  $("#topart").classList.remove("hidden");
  const u = state.me.user;
  who.innerHTML = `${esc(u.unit_code)} · ${esc(u.rank)} ${esc(u.name)} <button class="btn small ghost" id="logout" style="color:#fff;border-color:rgba(255,255,255,.4)">로그아웃</button>`;
  $("#logout").onclick = async () => {
    await api("POST", "logout");
    state.me = null;
    state.current = null;
    location.hash = "";
    render();
  };
  const v = view();
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === v));
  ({ inspect: renderInspect, report: renderReport, records: renderRecords, settings: renderSettings }[v] || renderInspect)();
}

let lastFetched = "";
async function pollStatus() {
  if (state.me) {
    try {
      state.status = await api("GET", "status");
      const line = $("#status-line");
      if (line) line.innerHTML = statusText(state.status);
      const stamp = state.status.fetched_at + "|" + state.status.error_kind;
      if (stamp !== lastFetched) {
        lastFetched = stamp;
        if (view() === "inspect" && $("#banner")) {
          loadBanner();
          loadNotices();
        }
        if (view() === "settings" && $("#data-status")) renderDataStatus();
      }
    } catch { /* 다음 번에 다시 */ }
  }
  setTimeout(pollStatus, state.status && state.status.refreshing ? 3000 : 30000);
}

/* ------------------------------------------------------------ 로그인·가입 */

function renderAuth(tab = "login") {
  $("#main").innerHTML = `
  <div class="auth-wrap">
  <div class="auth-art" role="img" aria-label="식자재를 싣고 부대로 들어오는 납품 트럭 그림">
    <div class="caption">
      <h1>오늘 들어온 식자재, 한 번에 확인</h1>
      <p>바코드 한 번, 품목명 한 줄로 회수·부적합 이력을 확인하고 이상 품목은 묶어서 보고합니다.</p>
    </div>
  </div>
  <div class="auth">
    <div class="auth-title"><img src="img/face.jpg" alt=""><div><h2>식자재 안전 지키미</h2><div class="muted small">급식 감독관용 검수 도구 (베타)</div></div></div>
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="login" class="${tab === "login" ? "on" : ""}">로그인</button>
      <button role="tab" data-tab="signup" class="${tab === "signup" ? "on" : ""}">가입</button>
    </div>
    <form id="auth-form" class="stack" autocomplete="off">
      <label class="field">아이디<input type="text" name="username" required autocomplete="username"></label>
      <label class="field">비밀번호${tab === "signup" ? " (8자 이상)" : ""}<input type="password" name="password" required autocomplete="${tab === "signup" ? "new-password" : "current-password"}"></label>
      ${tab === "signup" ? `
      <div class="row">
        <label class="field grow">계급<input type="text" name="rank" list="ranks" required></label>
        <label class="field grow">성명<input type="text" name="name" required></label>
      </div>
      <datalist id="ranks">${RANKS.map((r) => `<option value="${r}">`).join("")}</datalist>
      <label class="field">부대 코드<input type="text" name="unit_code" required placeholder="예: A123"></label>
      <p class="muted small">부대 코드는 미리 등록된 코드만 가입할 수 있습니다. 가입 후에는 바꿀 수 없습니다.</p>` : ""}
      <p class="err" id="auth-err" role="alert"></p>
      <button class="btn primary" type="submit">${tab === "login" ? "로그인" : "가입하고 시작하기"}</button>
      ${tab === "login" ? `<p class="muted small">비밀번호를 잊었다면 PC 관리자가 계정을 지운 뒤 다시 가입합니다 (베타).</p>` : ""}
    </form>
  </div>
  </div>`;
  $$(".tabs button").forEach((b) => (b.onclick = () => renderAuth(b.dataset.tab)));
  $("#auth-form [name=username]").focus();
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      await api("POST", tab, body);
      const r = await api("GET", "me");
      state.me = r.user ? r : null;
      location.hash = "inspect";
      render();
      pollNow();
    } catch (err) {
      $("#auth-err").textContent = err.message;
    }
  };
}

function pollNow() {
  lastFetched = "";
  api("GET", "status").then((s) => {
    state.status = s;
    const line = $("#status-line");
    if (line) line.innerHTML = statusText(s);
  }).catch(() => {});
}

/* ------------------------------------------------------------ 검수 화면 */

async function loadCurrent() {
  const r = await api("GET", "inspections/current");
  state.current = r.inspection ? r : null;
}

async function renderInspect() {
  const main = $("#main");
  main.innerHTML = `
  <section class="view">
    <div id="banner"></div>
    <div class="status-line" id="status-line">${statusText(state.status)}</div>
    <div class="notice-import">수입식품 부적합은 아직 조회하지 않습니다 (서비스 코드 확인 후 추가 예정).</div>
    <div id="inspect-box"></div>
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <h2>최근 회수·부적합 공지</h2>
        <div class="row" id="notice-ctl"></div>
      </div>
      <div id="notices"><p class="muted">불러오는 중…</p></div>
    </div>
  </section>`;
  loadBanner();
  loadNotices();
  try {
    await loadCurrent();
  } catch (e) {
    $("#inspect-box").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  renderInspectBox();
}

async function loadBanner() {
  const box = $("#banner");
  if (!box) return;
  try {
    state.banner = (await api("GET", "banner")).items;
  } catch {
    state.banner = [];
  }
  const list = state.banner;
  if (!list.length) {
    box.innerHTML = `<div class="banner none"><h2>최근 30일 1등급 회수 공지가 없습니다(안전하다는 뜻이 아닙니다)</h2></div>`;
    return;
  }
  const shown = state.bannerOpen ? list : list.slice(0, 3);
  box.innerHTML = `<div class="banner" role="alert">
    <h2>긴급 · 최근 30일 1등급 회수 공지 ${list.length}건</h2>
    <ul>${shown.map((r, i) => `<li><button type="button" class="pick" data-bidx="${i}">${thumb(r)}<span><span class="badge g1">1등급</span> <b>${esc(r.name)}</b> · ${esc(r.company)} · ${esc(r.created)}
      ${r.reason ? `<span class="small muted" style="display:block">${esc(r.reason.slice(0, 120))}</span>` : ""}</span></button></li>`).join("")}</ul>
    <p class="small muted" style="margin:6px 0 0">항목을 누르면 제품 사진과 날짜를 크게 봅니다.</p>
    <div class="row" style="margin-top:8px;gap:8px">
      ${list.length > 3 ? `<button class="btn small" id="banner-more">${state.bannerOpen ? "접기" : `외 ${list.length - 3}건 더 보기`}</button>` : ""}
      <button class="btn small" id="banner-read" ${TTS_OK ? "" : "disabled"}>긴급 공지 읽어 주기</button>
    </div>
  </div>`;
  $("#banner-read").onclick = () => speak(sayable(`최근 30일 1등급 회수 공지 ${list.length}건. ` +
    shown.map((r, i) => `${i + 1}번. ${r.name}, ${r.company}. ${r.reason || ""}.`).join(" ")));
  $$("[data-bidx]", box).forEach((b) => (b.onclick = () => showDetail(shown[+b.dataset.bidx])));
  const more = $("#banner-more");
  if (more) more.onclick = () => { state.bannerOpen = !state.bannerOpen; loadBanner(); };
}

async function loadNotices() {
  const box = $("#notices");
  if (!box) return;
  const n = state.notice;
  $("#notice-ctl").innerHTML = `
    <select id="n-src" aria-label="출처" style="width:auto">
      <option value="all">출처 전체</option><option value="recall">회수(I0490)</option><option value="unfit">부적합(I2620)</option>
    </select>
    <select id="n-grade" aria-label="등급" style="width:auto">
      <option value="all">등급 전체</option><option value="1">1등급</option><option value="2">2등급</option><option value="3">3등급</option>
    </select>
    <button class="btn small ${n.size === 5 ? "on primary" : ""}" data-size="5">5개씩</button>
    <button class="btn small ${n.size === 10 ? "on primary" : ""}" data-size="10">10개씩</button>`;
  $("#n-src").value = n.source;
  $("#n-grade").value = n.grade;
  $("#n-src").onchange = (e) => { n.source = e.target.value; n.page = 1; loadNotices(); };
  $("#n-grade").onchange = (e) => { n.grade = e.target.value; n.page = 1; loadNotices(); };
  $$("#notice-ctl [data-size]").forEach((b) => (b.onclick = () => { n.size = +b.dataset.size; n.page = 1; loadNotices(); }));
  let r;
  try {
    r = await api("GET", `notices?source=${n.source}&grade=${n.grade}&size=${n.size}&page=${n.page}`);
  } catch (e) {
    box.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  if (!r.items.length) {
    box.innerHTML = `<p class="muted">표시할 공지가 없습니다.</p>`;
    return;
  }
  box.innerHTML = r.items.map((x, i) => `
    <button type="button" class="notice-item pick" data-nidx="${i}">${thumb(x)}<span class="grow" style="display:grid;gap:4px">
      <span class="row" style="gap:6px"><span class="badge src">${x.source === "I0490" ? "회수" : "부적합"}</span>${gradeBadge(x)}
        <b>${esc(x.name)}</b><span class="muted">${esc(x.company)}</span><span class="muted small" style="margin-left:auto">${esc(x.created || x.created_raw)}</span></span>
      <span class="small muted">${esc(x.source === "I0490" ? x.reason : [x.test_item, x.test_result && `결과 ${x.test_result}`, x.standard && `기준 ${x.standard}`].filter(Boolean).join(" · "))}</span>
    </span></button>`).join("") + pager(r.total, r.page, r.size, "data-npage");
  $$("[data-npage]", box).forEach((b) => (b.onclick = () => { n.page = +b.dataset.npage; loadNotices(); }));
  $$("[data-nidx]", box).forEach((b) => (b.onclick = () => showDetail(r.items[+b.dataset.nidx])));
}

function renderInspectBox() {
  const box = $("#inspect-box");
  if (!box) return;
  // 검수 시작 버튼 없이 바로 조회할 수 있게 하고, 첫 품목을 기록할 때 회차를 자동으로 만든다
  const cur = state.current;
  const ins = cur ? cur.inspection : null;
  const items = cur ? cur.items : [];
  const pass = items.filter((i) => i.result === "pass").length;
  const issue = items.filter((i) => i.result === "issue").length;
  box.innerHTML = `
  <div class="card stack">
    <div class="hero">
    <div class="stack">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div class="grow">
        ${ins ? `<h2>검수 중 · ${esc(ins.vendor)} <button class="btn small ghost" id="vendor-edit" type="button">납품업체 바꾸기</button></h2>
          <div class="muted small">시작 ${esc(ins.started_at.slice(0, 16))} · 회차 ${ins.id}</div>`
        : `<h2>검수 · ${nowText()}</h2>
          <label class="field" style="margin-top:8px;max-width:420px">납품업체 (선택, 나중에 바꿀 수 있음)
            <input type="text" id="vendor-in" list="vendors" placeholder="예: △△유통" value="${esc(state.pendingVendor || "")}"></label>
          <datalist id="vendors"></datalist>
          <div class="muted small" style="margin-top:4px">아래에서 바로 조회하세요. 첫 품목을 기록하면 검수 회차가 자동으로 시작됩니다.</div>`}
      </div>
    </div>
      <div class="counter" aria-live="polite"><div>통과 <b>${pass}</b>건</div><div style="background:var(--g1-soft);color:var(--g1)">이상 <b>${issue}</b>건</div></div>
    </div>
    </div>
    <div class="methods" role="group" aria-label="확인 방법">
      <button class="btn big ${state.method === "barcode" ? "on" : ""}" data-method="barcode">① 바코드<span>웹캠 · 사진 파일 · 숫자 입력</span></button>
      <button class="btn big ${state.method === "ocr" ? "on" : ""}" data-method="ocr">② 촬영 글자 인식<span>웹캠으로 포장지 찍기 → 글자 채우기</span></button>
      <button class="btn big ${state.method === "manual" ? "on" : ""}" data-method="manual">③ 직접 입력<span>품목명 · 업체명</span></button>
    </div>
    <div class="voice-bar">
      <label><input type="checkbox" id="auto-read" ${prefGet("autoRead", false) ? "checked" : ""} ${TTS_OK ? "" : "disabled"}> 조회 결과 자동으로 읽어 주기</label>
      <button class="btn small" id="stop-read" type="button">읽기 멈춤</button>
      ${SR ? `<span class="muted small">입력칸 옆 "음성"을 누르면 말로 입력합니다 (인터넷 필요).</span>` : ""}
    </div>
    <div id="method-panel" class="panel"></div>
    <div id="results"></div>
    ${ins ? `<div class="row" style="justify-content:flex-end;border-top:1px solid var(--line);padding-top:16px">
      <button class="btn" id="close-insp">검수 마치기</button>
      <button class="btn primary" id="go-report">보고하기 (이상 ${issue}건)</button>
    </div>` : ""}
  </div>`;
  $$("[data-method]").forEach((b) => (b.onclick = () => {
    state.method = b.dataset.method;
    state.search = null;
    renderInspectBox();
    renderMethodPanel(true);
  }));
  $("#auto-read").onchange = (e) => { prefSet("autoRead", e.target.checked); if (!e.target.checked) stopSpeak(); };
  $("#stop-read").onclick = stopSpeak;
  renderMethodPanel();
  renderResults();
  if (!ins) {
    $("#vendor-in").oninput = (e) => { state.pendingVendor = e.target.value; };
    api("GET", "vendors").then((r) => {
      const dl = $("#vendors");
      if (dl) dl.innerHTML = r.items.map((v) => `<option value="${esc(v)}">`).join("");
    }).catch(() => {});
    return;
  }
  $("#vendor-edit").onclick = async () => {
    const v = prompt("납품업체 이름", ins.vendor === VENDOR_NONE ? "" : ins.vendor);
    if (v === null || !v.trim()) return;
    try {
      state.current = await api("PUT", `inspections/${ins.id}`, { vendor: v.trim() });
      renderInspectBox();
    } catch (err) { toast(err.message); }
  };
  $("#go-report").onclick = () => { location.hash = "report"; };
  $("#close-insp").onclick = async () => {
    if (issue && !ins.reported && !confirm("아직 보고 완료로 기록하지 않은 이상 품목이 있습니다. 그래도 검수를 마칠까요?")) return;
    await api("POST", `inspections/${ins.id}/close`);
    state.current = null;
    state.search = null;
    toast("검수를 마쳤습니다. 검수 기록에서 다시 볼 수 있습니다.");
    renderInspectBox();
  };
}

/* ---------- 확인 방법 패널 */

// focus: 확인 방법 버튼을 눌렀을 때만 입력칸으로 옮김 (처음 열 때 화면이 아래로 튀지 않게)
function renderMethodPanel(focus) {
  const p = $("#method-panel");
  stopCamera();
  if (listening) listening.stop();
  if (!state.method) {
    p.innerHTML = `<p class="muted">위에서 확인 방법을 고르세요.</p>`;
    return;
  }
  if (state.method === "barcode") {
    p.innerHTML = `
    <div class="stack">
      <div class="row">
        <button class="btn" id="cam-btn">웹캠 켜기</button>
        <label class="btn">사진 파일 올리기<input type="file" accept="image/*" id="bc-file" class="hidden"></label>
        <span class="muted small">휴대폰으로 찍은 바코드 사진을 PC로 옮겨 올려도 됩니다.</span>
      </div>
      <video id="cam" class="cam hidden" muted playsinline></video>
      <p id="bc-msg" class="small" role="status"></p>
      <form id="bc-form" class="row">
        <label class="field grow">바코드 숫자${withMic(`<input type="text" inputmode="numeric" name="barcode" id="bc-input" placeholder="인식이 안 되면 숫자를 입력하거나 불러 주세요">`, "bc-input", true)}</label>
        <button class="btn primary" type="submit" style="align-self:flex-end">조회</button>
      </form>
    </div>`;
    $("#cam-btn").onclick = toggleCamera;
    $("#bc-file").onchange = (e) => e.target.files[0] && decodeBarcodeFile(e.target.files[0]);
    $("#bc-form").onsubmit = (e) => {
      e.preventDefault();
      const bc = $("#bc-input").value.replace(/\D/g, "");
      if (!bc) return toast("바코드 숫자를 입력하세요");
      doSearch({ method: "barcode", barcode: bc });
    };
    if (focus) $("#bc-input").focus();
  } else if (state.method === "ocr") {
    // 사진 글자 인식은 웹캠 촬영이 기본. 사진 파일은 웹캠이 없을 때만 쓰는 예비 수단
    p.innerHTML = `
    <div class="stack">
      <div class="shoot">
        <video id="ocr-cam" class="cam hidden" autoplay muted playsinline></video>
        <img id="ocr-img" class="cam hidden" alt="찍은 포장지 사진">
        <div class="row">
          <button class="btn primary big-shot" id="ocr-shot" type="button">웹캠 켜기</button>
          <span class="muted small" id="ocr-tip">제품명이 화면에 크게, 흔들리지 않게 보이도록 비추세요.</span>
        </div>
        <label class="small muted file-alt">웹캠이 없으면 <u>사진 파일로 대신 올리기</u><input type="file" accept="image/*" id="ocr-file" class="hidden"></label>
      </div>
      <label class="field">인식한 글자 (고쳐서 쓰세요)<textarea id="ocr-text" placeholder="사진을 찍으면 읽은 글자가 여기에 채워집니다"></textarea></label>
      <p id="ocr-msg" class="progress" role="status"></p>
      <form id="ocr-form" class="row">
        <label class="field grow">품목명${withMic(`<input type="text" id="ocr-q" name="q">`, "ocr-q")}</label>
        <label class="field grow">업체명 (선택)${withMic(`<input type="text" id="ocr-c" name="company">`, "ocr-c")}</label>
        <button class="btn primary" type="submit" style="align-self:flex-end">조회</button>
      </form>
      <p class="muted small">글자 인식은 틀릴 수 있습니다. 품목명을 실물과 대조해 고친 뒤 조회하세요.</p>
    </div>`;
    $("#ocr-file").onchange = (e) => {
      if (!e.target.files[0]) return;
      stopCamera();
      runOcr(e.target.files[0]);
    };
    $("#ocr-shot").onclick = () => (ocrStream ? ocrShoot() : ocrCameraOn());
    if (focus) ocrCameraOn();
    $("#ocr-form").onsubmit = (e) => {
      e.preventDefault();
      const q = $("#ocr-q").value.trim();
      if (!q) return toast("품목명을 입력하세요");
      doSearch({ method: "ocr", q, company: $("#ocr-c").value.trim() });
    };
  } else {
    p.innerHTML = `
    <form id="man-form" class="row">
      <label class="field grow">품목명${withMic(`<input type="text" id="man-q" placeholder="예: 깻잎, 고수, ○○햄" required>`, "man-q")}</label>
      <label class="field grow">업체명 (선택)${withMic(`<input type="text" id="man-c" placeholder="제조사·판매원">`, "man-c")}</label>
      <button class="btn primary" type="submit" style="align-self:flex-end">조회</button>
    </form>
    <p class="muted small" style="margin-top:8px">농산물은 자료의 업소명이 가려져 있어(예: 이*경) 품목명으로만 대조합니다.</p>`;
    $("#man-form").onsubmit = (e) => {
      e.preventDefault();
      doSearch({ method: "manual", q: $("#man-q").value.trim(), company: $("#man-c").value.trim() });
    };
    if (focus) $("#man-q").focus();
  }
  bindMics(p);
}

/* ---------- 바코드 */

let reader = null;
function zxingReader() {
  const hints = new Map();
  const F = ZXing.BarcodeFormat;
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  return new ZXing.BrowserMultiFormatReader(hints);
}

function stopCamera() {
  if (reader) {
    try { reader.reset(); } catch { /* 무시 */ }
    reader = null;
  }
  if (ocrStream) {
    ocrStream.getTracks().forEach((t) => t.stop());
    ocrStream = null;
  }
}

async function toggleCamera() {
  const video = $("#cam");
  const btn = $("#cam-btn");
  const msg = $("#bc-msg");
  if (reader) {
    stopCamera();
    video.classList.add("hidden");
    btn.textContent = "웹캠 켜기";
    msg.textContent = "";
    return;
  }
  if (typeof ZXing === "undefined") return (msg.textContent = "바코드 인식 기능을 불러오지 못했습니다. 숫자를 직접 입력하세요.");
  reader = zxingReader();
  video.classList.remove("hidden");
  btn.textContent = "웹캠 끄기";
  msg.textContent = "바코드를 웹캠 가운데에 비추세요.";
  try {
    await reader.decodeFromVideoDevice(null, video, (result) => {
      if (!result || !reader) return;
      const text = result.getText();
      stopCamera();
      video.classList.add("hidden");
      btn.textContent = "웹캠 켜기";
      gotBarcode(text);
    });
  } catch (e) {
    stopCamera();
    video.classList.add("hidden");
    btn.textContent = "웹캠 켜기";
    msg.textContent = "웹캠을 켤 수 없습니다. 사진 파일 올리기나 숫자 직접 입력을 쓰세요.";
  }
}

function gotBarcode(text) {
  const bc = String(text).replace(/\D/g, "");
  const input = $("#bc-input");
  if (input) input.value = bc || text;
  const msg = $("#bc-msg");
  if (!bc) {
    if (msg) msg.textContent = `숫자 바코드가 아닙니다: ${text}`;
    return;
  }
  if (msg) msg.textContent = `읽은 바코드: ${bc}`;
  doSearch({ method: "barcode", barcode: bc });
}

/* 웹캠으로 한 장 찍기. 찍은 사진(File)을 돌려주고, 취소하거나 웹캠이 없으면 null */
function captureFromCamera(title) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal wide" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>
      <video class="cam" autoplay muted playsinline style="max-width:100%"></video>
      <p class="small muted" role="status">웹캠을 켜는 중입니다…</p>
      <div class="row" style="justify-content:flex-end">
        <button class="btn" data-cancel type="button">취소</button>
        <button class="btn primary" data-shot type="button" disabled>찍기</button>
      </div></div>`;
    document.body.appendChild(back);
    const video = $("video", back);
    const msg = $("[role=status]", back);
    let stream = null;
    const done = (file) => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      back.remove();
      resolve(file);
    };
    $("[data-cancel]", back).onclick = () => done(null);
    back.addEventListener("keydown", (e) => e.key === "Escape" && done(null));
    $("[data-shot]", back).onclick = () => {
      const c = document.createElement("canvas");
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0);
      c.toBlob((b) => done(b ? new File([b], "webcam.jpg", { type: "image/jpeg" }) : null), "image/jpeg", 0.92);
    };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = "이 브라우저에서는 웹캠을 쓸 수 없습니다. 사진 파일을 올리세요.";
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } }).then((s) => {
      stream = s;
      video.srcObject = s;
      msg.textContent = "포장지가 화면에 크게, 흔들리지 않게 보이면 '찍기'를 누르세요.";
      $("[data-shot]", back).disabled = false;
      $("[data-shot]", back).focus();
    }).catch(() => {
      msg.textContent = "웹캠을 켤 수 없습니다. 웹캠 연결과 브라우저의 카메라 허용을 확인하거나, 사진 파일을 올리세요.";
    });
  });
}

function loadImage(file) {
  return new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = bad;
    img.src = URL.createObjectURL(file);
  });
}

async function decodeBarcodeFile(file) {
  const msg = $("#bc-msg");
  msg.textContent = "사진에서 바코드를 찾는 중입니다…";
  if (typeof ZXing === "undefined") return (msg.textContent = "바코드 인식 기능을 불러오지 못했습니다. 숫자를 직접 입력하세요.");
  let img;
  try {
    img = await loadImage(file);
  } catch {
    return (msg.textContent = "사진을 열 수 없습니다.");
  }
  const r = zxingReader();
  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  const sizes = [Math.min(longSide, 2000), 1400, 900].filter((s, i, a) => s <= longSide && a.indexOf(s) === i);
  for (const size of sizes) {
    const scale = size / longSide;
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    try {
      const res = await r.decodeFromImageUrl(c.toDataURL("image/png"));
      return gotBarcode(res.getText());
    } catch { /* 다음 크기로 */ }
  }
  msg.textContent = "바코드를 읽지 못했습니다. 바코드 아래 숫자를 직접 입력하세요.";
  $("#bc-input").focus();
}

/* ---------- 사진 글자 인식 */

let ocrWorker = null;
let ocrProgress = () => {};
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await Tesseract.createWorker(["kor", "eng"], 1, {
    workerPath: "vendor/tesseract/worker.min.js",
    corePath: "vendor/tesseract/core",
    langPath: "vendor/tesseract/lang",
    logger: (m) => ocrProgress(m),
  });
  return ocrWorker;
}

function bestLine(text) {
  const lines = text.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const scored = lines.map((l) => ({ l, h: (l.match(/[가-힣]/g) || []).length }));
  const good = scored.filter((x) => x.h >= 2);
  if (!good.length) return lines[0] || "";
  good.sort((a, b) => b.h - a.h);
  return good[0].l.slice(0, 60);
}

/* 글자 인식용 웹캠: 패널 안에서 바로 보여 주고, 찍으면 그 사진으로 글자를 읽음 */
let ocrStream = null;
async function ocrCameraOn() {
  const video = $("#ocr-cam");
  const btn = $("#ocr-shot");
  const msg = $("#ocr-msg");
  if (!video) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msg.textContent = "이 브라우저에서는 웹캠을 쓸 수 없습니다. 사진 파일로 대신 올리세요.";
    return;
  }
  btn.disabled = true;
  msg.textContent = "웹캠을 켜는 중입니다…";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } });
    if (!$("#ocr-cam")) return s.getTracks().forEach((t) => t.stop()); // 그사이 다른 화면으로 옮김
    stopCamera();
    ocrStream = s;
    video.srcObject = s;
    video.classList.remove("hidden");
    $("#ocr-img").classList.add("hidden");
    btn.textContent = "찍기";
    msg.textContent = "포장지가 크게 보이면 '찍기'를 누르세요.";
    btn.focus();
  } catch {
    msg.textContent = "웹캠을 켤 수 없습니다. 웹캠 연결과 브라우저의 카메라 허용을 확인하거나, 사진 파일로 대신 올리세요.";
  } finally {
    btn.disabled = false;
  }
}

function ocrShoot() {
  const video = $("#ocr-cam");
  if (!video || !video.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  stopCamera();
  video.classList.add("hidden");
  $("#ocr-shot").textContent = "다시 찍기";
  c.toBlob((b) => b && runOcr(new File([b], "webcam.jpg", { type: "image/jpeg" })), "image/jpeg", 0.92);
}

async function runOcr(file) {
  const msg = $("#ocr-msg");
  const img = $("#ocr-img");
  if (!img) return;
  img.src = URL.createObjectURL(file);
  img.classList.remove("hidden");
  $("#ocr-shot").textContent = "다시 찍기";
  msg.textContent = "글자를 읽는 중입니다… (처음 한 번은 인식 자료를 불러오느라 오래 걸릴 수 있습니다)";
  if (typeof Tesseract === "undefined") return (msg.textContent = "글자 인식 기능을 불러오지 못했습니다. 직접 입력을 쓰세요.");
  ocrProgress = (m) => {
    if (m.status === "recognizing text") msg.textContent = `글자를 읽는 중입니다… ${Math.round(m.progress * 100)}%`;
  };
  try {
    const w = await getOcrWorker();
    const { data } = await w.recognize(file);
    const text = (data.text || "").trim();
    if (!$("#ocr-text")) return;
    $("#ocr-text").value = text;
    $("#ocr-q").value = bestLine(text);
    msg.textContent = text ? "다 읽었습니다. 품목명을 실물과 대조해 고친 뒤 조회하세요." : "글자를 찾지 못했습니다. 직접 입력하세요.";
    $("#ocr-q").focus();
  } catch (e) {
    ocrWorker = null;
    msg.textContent = "글자를 읽지 못했습니다. 직접 입력하세요.";
  }
}

/* ---------- 조회와 결과 */

async function doSearch(s) {
  const qs = new URLSearchParams();
  if (s.barcode) qs.set("barcode", s.barcode);
  if (s.q) qs.set("q", s.q);
  if (s.company) qs.set("company", s.company);
  try {
    const r = await api("GET", "search?" + qs);
    state.search = { ...s, items: r.items, total: r.total, page: 1 };
  } catch (e) {
    return toast(e.message);
  }
  renderResults();
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  if (prefGet("autoRead", false)) speak(resultsSpeech());
}

const NONE_SPEECH = "회수·부적합 이력 없음. 이력이 없어도 안전이 보장되지는 않습니다. 변질, 파손, 표시 누락을 꼭 눈으로 확인하세요.";

function resultsSpeech() {
  const s = state.search;
  if (!s) return "";
  if (!s.items.length) return NONE_SPEECH;
  const start = (s.page - 1) * CAND_PAGE;
  const page = s.items.slice(start, start + CAND_PAGE);
  let t = `문제 후보 ${s.total}건. ` + page.map((r, i) => `${start + i + 1}번. ${candidateSpeech(r)}`).join(" ");
  if (s.total > start + page.length) t += " 나머지 후보는 화면에서 다음 쪽을 확인하세요.";
  return t;
}

function imageSrc(r, i) {
  return `/api/image?src=${r.source}&seq=${encodeURIComponent(r.seq)}&i=${i}`;
}

function thumb(r) {
  if (!r.image_count) return `<span class="thumb none" aria-hidden="true">사진<br>없음</span>`;
  return `<img class="thumb" loading="lazy" src="${imageSrc(r, 0)}" alt="" onerror="this.outerHTML='<span class=&quot;thumb none&quot;>사진<br>없음</span>'">`;
}

/* 공지·배너에서 누른 제품: 결과 카드와 같은 모양으로 크게 보여 주고 바로 기록할 수 있게 */
function showDetail(rec) {
  stopSpeak();
  const r = { ...rec, match_by: "공지에서 선택", company_match: false };
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal wide" role="dialog" aria-modal="true" aria-label="${esc(r.name)} 상세">
    ${candidateCard(r, 0)}
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>닫기</button></div>
  </div>`;
  document.body.appendChild(back);
  const close = () => { stopSpeak(); back.remove(); };
  $("[data-close]", back).onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  const ctx = () => { state.search = { method: "manual", q: r.name, items: [r], total: 1, page: 1 }; };
  $("[data-match]", back).onclick = async () => { ctx(); close(); await recordMatch(r); };
  $("[data-mismatch]", back).onclick = async () => { ctx(); close(); await recordPass("lot_mismatch", r); };
  $("[data-say]", back).onclick = () => speak(candidateSpeech(r));
  $("[data-close]", back).focus();
}

function productImages(r) {
  if (!r.image_count) return "";
  const n = Math.min(r.image_count, 3);
  const imgs = [];
  for (let i = 0; i < n; i++) {
    const src = imageSrc(r, i);
    imgs.push(`<a href="${src}" target="_blank" rel="noopener"><img class="prod-img" loading="lazy" src="${src}" alt="${esc(r.name)} 제품 사진 ${i + 1}"
      onerror="this.parentNode.remove()"></a>`);
  }
  return `<figure class="prod-imgs">${imgs.join("")}
    <figcaption class="small muted">제품 사진 출처: 식품안전나라 · 이용 조건 확인 전이므로 검수 확인용으로만 쓰세요. 사진을 누르면 크게 봅니다.</figcaption></figure>`;
}

function dateBox(label, d) {
  if (!d || !d.raw) return `<div class="date-box"><div class="label">${label}</div><div class="value muted" style="font-size:1rem">자료에 없음</div></div>`;
  return `<div class="date-box"><div class="label">${label}${d.note ? ` (${esc(d.note)} 표시)` : ""}</div>
    <div class="value">${esc(d.text)}</div>
    ${d.ok && d.raw !== d.text ? `<div class="raw">원문: ${esc(d.raw)}</div>` : ""}
    ${!d.ok ? `<div class="raw">숫자 날짜로 바꿀 수 없어 원문 그대로 표시</div>` : ""}</div>`;
}

function candidateCard(r, idx) {
  const g1 = r.source === "I0490" && (r.grade || "").includes("1");
  const kv = [];
  if (r.source === "I0490") {
    kv.push(["등급", esc(r.grade || "등급 없음")]);
    if (r.reason) kv.push(["회수 사유", esc(r.reason)]);
  } else if (r.source === "I2620") {
    if (r.test_item) kv.push(["부적합 항목", esc(r.test_item)]);
    if (r.standard) kv.push(["기준규격", esc(r.standard)]);
    if (r.test_result) kv.push(["검사결과", esc(r.test_result)]);
  } else {
    if (r.reason) kv.push(["문제 성분", esc(r.reason)]);
    if (r.country) kv.push(["제조국", esc(r.country)]);
  }
  if (r.food_type) kv.push(["식품유형", esc(r.food_type)]);
  if (r.pack_unit) kv.push(["포장단위", esc(r.pack_unit)]);
  if (r.barcodes.length) kv.push(["바코드", esc(r.barcodes.join(", "))]);
  kv.push(["등록일", esc(r.created || r.created_raw || "-")]);
  const hasDates = r.source !== "I2715";
  return `
  <article class="cand ${g1 ? "g1" : ""}">
    ${g1 ? `<div class="stop">급식에 쓰지 마세요 · 1등급 회수 대상 후보</div>` : ""}
    <div class="cand-title">${gradeBadge(r)}<h3>${CAND_TITLE[r.source]}</h3>
      <span class="badge src">${SRC_LABEL[r.source]}</span><span class="badge src">${esc(r.match_by)}</span>
      ${r.company_match ? `<span class="badge g2">업체명 일치</span>` : ""}</div>
    <div><div style="font-size:1.25rem;font-weight:800">${esc(r.name)}</div>
      <div class="muted">${esc(r.company || "업체명 없음")}${r.source === "I2715" ? " (제조사)" : ""}</div></div>
    ${productImages(r)}
    ${hasDates ? `<div class="dates">${dateBox("제조일자", r.mfg)}${dateBox("소비기한", r.exp)}</div>
      <div class="check-hint">실물 포장의 날짜와 같은지 확인하세요.</div>`
      : `<div class="check-hint">자료에 날짜가 없습니다. 제품명·제조사·바코드를 실물과 대조하세요.</div>`}
    <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="row">
      <button class="btn danger" data-match="${idx}">일치함 → 보고 목록에 담기</button>
      <button class="btn" data-mismatch="${idx}">날짜 다름 → 육안 확인 후 통과 기록</button>
      <button class="btn ghost" data-say="${idx}" ${TTS_OK ? "" : "disabled"}>이 후보 읽어 주기</button>
    </div>
  </article>`;
}

function renderResults() {
  const box = $("#results");
  if (!box) return;
  const s = state.search;
  if (!s) {
    box.innerHTML = "";
    return;
  }
  const what = s.barcode ? `바코드 ${s.barcode}` : `"${s.q}"${s.company ? ` · ${s.company}` : ""}`;
  if (!s.items.length) {
    box.innerHTML = `
    <div class="none-box">
      <div class="muted small">조회: ${esc(what)}</div>
      <div class="title">회수·부적합 이력 없음</div>
      <div class="caution">이력이 없어도 안전이 보장되지는 않습니다. 변질·파손·표시 누락을 꼭 눈으로 확인하세요.</div>
      <div class="row">
        <button class="btn primary" id="pass-none">육안 확인 후 통과 기록</button>
        <button class="btn" id="visual">육안 이상 보고</button>
        <button class="btn ghost" id="read-results" ${TTS_OK ? "" : "disabled"}>읽어 주기</button>
        <button class="btn ghost" id="clear-search">조회 지우기</button>
      </div>
    </div>`;
    $("#pass-none").onclick = () => recordPass("none");
  } else {
    const start = (s.page - 1) * CAND_PAGE;
    const page = s.items.slice(start, start + CAND_PAGE);
    box.innerHTML = `
    <div class="stack">
      <div class="row" style="justify-content:space-between">
        <h2 style="color:var(--g1)">문제 후보 ${s.total}건 <span class="muted small" style="font-weight:500">조회: ${esc(what)}</span></h2>
        <button class="btn small" id="read-results" ${TTS_OK ? "" : "disabled"}>이 쪽 결과 읽어 주기</button>
      </div>
      ${s.total > 1 && s.q ? `<p class="muted small">같은 품목명이 여러 건입니다. 산지·업체·날짜를 함께 확인하세요.</p>` : ""}
      ${page.map((r, i) => candidateCard(r, start + i)).join("")}
      ${pager(s.items.length, s.page, CAND_PAGE, "data-cpage")}
      <div class="row" style="border-top:1px dashed var(--line);padding-top:12px">
        <span class="muted small grow">후보와 날짜가 달라도 눈으로 이상이 보이면:</span>
        <button class="btn" id="visual">육안 이상 보고</button>
        <button class="btn ghost" id="clear-search">조회 지우기</button>
      </div>
    </div>`;
    $$("[data-cpage]", box).forEach((b) => (b.onclick = () => { s.page = +b.dataset.cpage; renderResults(); }));
    $$("[data-match]", box).forEach((b) => (b.onclick = () => recordMatch(s.items[+b.dataset.match])));
    $$("[data-mismatch]", box).forEach((b) => (b.onclick = () => recordPass("lot_mismatch", s.items[+b.dataset.mismatch])));
    $$("[data-say]", box).forEach((b) => (b.onclick = () => speak(candidateSpeech(s.items[+b.dataset.say]))));
  }
  $("#read-results").onclick = () => speak(resultsSpeech());
  $("#visual").onclick = () => visualDialog();
  $("#clear-search").onclick = () => { state.search = null; renderInspectBox(); };
}

function searchName(s, rec) {
  if (s.q) return s.q;
  if (rec) return rec.name;
  return s.barcode ? `바코드 ${s.barcode}` : "";
}

async function addItem(body) {
  if (!state.current) {
    state.current = await api("POST", "inspections", { vendor: (state.pendingVendor || "").trim() || VENDOR_NONE });
    state.pendingVendor = "";
  }
  const ins = state.current.inspection;
  await api("POST", `inspections/${ins.id}/items`, body);
  await loadCurrent();
}

async function recordMatch(rec) {
  const s = state.search;
  try {
    await addItem({
      result: "issue", match: "lot_match", basis: rec.source, method: s.method,
      name: rec.name, barcode: s.barcode || rec.barcodes[0] || "", source_seq: rec.seq, grade: rec.grade,
      maker: rec.company, mfg_date: rec.mfg ? rec.mfg.text : "", exp_date: rec.exp ? rec.exp.text : "",
      detail: {
        source_label: SRC_LABEL[rec.source], reason: rec.reason, test_item: rec.test_item, standard: rec.standard,
        test_result: rec.test_result, food_type: rec.food_type, pack_unit: rec.pack_unit, created: rec.created,
        country: rec.country, query: s.q || s.barcode,
      },
    });
  } catch (e) { return toast(e.message); }
  const added = state.current.items[state.current.items.length - 1];
  state.search = null;
  renderInspectBox();
  toast(`보고 목록에 담았습니다 · 앱 제안: ${added ? added.suggested : ""}. 수량은 보고 화면에서 입력하세요.`);
}

async function recordPass(match, rec) {
  const s = state.search;
  const body = { result: "pass", match, method: s.method, name: searchName(s, rec), barcode: s.barcode || "" };
  if (rec) {
    body.basis = rec.source;
    body.source_seq = rec.seq;
    body.memo = `후보 있었으나 로트 불일치 (후보: ${rec.name} / ${SRC_LABEL[rec.source]} ${rec.seq})`;
  }
  try { await addItem(body); } catch (e) { return toast(e.message); }
  state.search = null;
  renderInspectBox();
  toast(match === "none" ? "통과로 기록했습니다." : "로트 불일치 · 통과로 기록했습니다.");
}

function visualDialog() {
  const s = state.search || {};
  const types = state.me.visual_types;
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
  <form class="modal" role="dialog" aria-modal="true" aria-labelledby="v-title">
    <h2 id="v-title">육안 이상 보고</h2>
    <p class="muted small">이력과 관계없이 눈으로 본 이상을 보고 목록에 담습니다. 앱 제안: 보고 후 결정</p>
    <label class="field">품목명${withMic(`<input type="text" name="name" id="v-name" required value="${esc(s.q || "")}">`, "v-name")}</label>
    <fieldset class="stack" style="border:0;padding:0;margin:0">
      <legend class="small" style="font-weight:600;color:var(--ink-2)">불량 유형</legend>
      <div class="row">${types.map((t, i) => `<label class="btn small"><input type="radio" name="defect_type" value="${t}" ${i === 0 ? "checked" : ""}> ${t}</label>`).join("")}</div>
    </fieldset>
    <div class="row">
      <label class="field grow">수량<input type="text" name="qty" inputmode="decimal"></label>
      <label class="field grow">단위<input type="text" name="unit" list="unit-list" value="kg"></label>
    </div>
    <datalist id="unit-list">${UNITS.map((u) => `<option value="${u}">`).join("")}</datalist>
    <label class="field">메모 (선택)${withMic(`<input type="text" name="memo" id="v-memo" placeholder="예: 겉잎 물러짐, 냄새">`, "v-memo")}</label>
    <div class="field">사진 (선택, PDF 보고서에만 들어감)
      <div class="row">
        <button class="btn small" type="button" data-vcam>웹캠으로 찍기</button>
        <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" style="flex:1">
      </div>
      <span class="small muted" data-vcam-msg></span>
    </div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn" type="button" data-cancel>취소</button>
      <button class="btn primary" type="submit">보고 목록에 담기</button>
    </div>
  </form>`;
  document.body.appendChild(back);
  const form = $("form", back);
  bindMics(back);
  $("#v-name").focus();
  const close = () => {
    if (listening) listening.stop();
    back.remove();
  };
  $("[data-cancel]", back).onclick = close;
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  let shot = null;
  $("[data-vcam]", back).onclick = async () => {
    shot = await captureFromCamera("이상 품목 찍기");
    if (shot) $("[data-vcam-msg]", back).textContent = "웹캠 사진 1장이 준비됐습니다.";
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    if (shot) f.set("photo", shot);
    try {
      await addItem({
        result: "issue", basis: "visual", match: s.items && s.items.length ? "lot_mismatch" : "none",
        method: s.method || "manual", barcode: s.barcode || "", name: f.get("name"), defect_type: f.get("defect_type"),
        qty: f.get("qty"), unit: f.get("unit"), memo: f.get("memo"),
      });
      const photo = f.get("photo");
      const added = state.current.items[state.current.items.length - 1];
      if (photo && photo.size && added) {
        await api("POST", `items/${added.id}/photo`, undefined, photo);
        await loadCurrent();
      }
    } catch (err) { return toast(err.message); }
    close();
    state.search = null;
    renderInspectBox();
    toast("육안 이상을 보고 목록에 담았습니다 · 앱 제안: 보고 후 결정");
  };
}

/* ------------------------------------------------------------ 보고 화면 */

async function renderReport() {
  const main = $("#main");
  main.innerHTML = `<p class="muted">불러오는 중…</p>`;
  const idPart = location.hash.split("/")[1];
  let data;
  try {
    if (idPart) data = await api("GET", `inspections/${+idPart}`);
    else {
      await loadCurrent();
      data = state.current;
    }
  } catch (e) {
    main.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  if (!data || !data.inspection) {
    main.innerHTML = `<div class="card empty-art"><img src="img/inspector.jpg" alt="검수표를 든 고양이 급식 감독관 그림">
      <div class="stack"><h2>보고 목록</h2><p>진행 중인 검수가 없습니다. 검수 화면에서 품목을 조회해 기록하거나, 검수 기록에서 지난 회차를 여세요.</p>
      <div class="row"><a class="btn primary" href="#inspect">검수 화면으로</a><a class="btn" href="#records">검수 기록</a></div></div></div>`;
    return;
  }
  const ins = data.inspection;
  const issues = data.items.filter((i) => i.result === "issue");
  const u = state.me.user;
  const managers = data.managers || [];
  main.innerHTML = `
  <section class="view">
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>보고 목록 · 이상 품목 ${issues.length}건</h2>
        ${ins.reported ? `<span class="badge pass">보고 완료 ${esc((ins.reported_at || "").slice(0, 16))}</span>` : `<span class="badge issue">보고 전${ins.reported_at ? ` · 지난 보고 ${esc(ins.reported_at.slice(0, 16))} 뒤 추가됨` : ""}</span>`}
      </div>
      <dl class="kv" style="margin-top:12px">
        <dt>부대 코드</dt><dd>${esc(ins.unit_code)}</dd>
        <dt>작성자</dt><dd>${esc(ins.author)}</dd>
        <dt>납품업체</dt><dd>${esc(ins.vendor)}</dd>
        <dt>검수 시작</dt><dd>${esc(ins.started_at.slice(0, 16))} (회차 ${ins.id})</dd>
      </dl>
      <p class="muted small" style="margin-top:8px">분류는 앱의 제안입니다. 실제 조치는 관리자와 지휘계통이 결정합니다.</p>
    </div>
    <div id="issue-list" class="stack">${issues.length ? "" : `<div class="card"><p>담긴 이상 품목이 없습니다. 검수 화면의 "일치함" 또는 "육안 이상 보고"로 담으세요.</p></div>`}</div>
    ${issues.length ? `
    <div class="card stack">
      <h2>보고 보내기</h2>
      <div class="managers"><b>보낼 사람 (설정의 관리자)</b>
        ${managers.length ? managers.map((m) => `<div>${esc(m.role)} ${esc(m.name)} · <b>${esc(m.phone)}</b></div>`).join("") : `<div class="muted">관리자가 없습니다. <a href="#settings">설정</a>에서 최대 3명을 넣으세요.</div>`}
      </div>
      <div class="row">
        <button class="btn primary" id="copy-text">문자 내용 복사</button>
        <button class="btn" id="read-report" ${TTS_OK ? "" : "disabled"}>보고 문구 읽어 주기</button>
        <button class="btn" id="pdf">PDF 보고서</button>
        <button class="btn" id="mark-reported">${ins.reported ? "보고 완료 다시 기록" : "보고 완료로 기록"}</button>
      </div>
      <p class="muted small">PC 메신저(예: PC 카카오톡)나 Windows '휴대폰과 연결'의 문자 창에 붙여 넣어 보내세요. 휴대폰 문자로 보낼 때는 아래 문구를 보고 옮겨 적어도 됩니다.</p>
      <div id="report-text" class="report-text hidden" aria-live="polite"></div>
    </div>` : ""}
  </section>`;
  const list = $("#issue-list");
  issues.forEach((it) => list.appendChild(issueEditor(it, ins)));
  if (!issues.length) return;
  $("#copy-text").onclick = async () => {
    const r = await api("GET", `inspections/${ins.id}/report`);
    const box = $("#report-text");
    box.textContent = r.text;
    box.classList.remove("hidden");
    let ok = false;
    try {
      await navigator.clipboard.writeText(r.text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = r.text;
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    }
    toast(ok ? `문자 내용을 복사했습니다 (${r.count}건). 메신저에 붙여 넣으세요.` : "복사하지 못했습니다. 아래 문구를 직접 선택해 복사하세요.");
  };
  $("#read-report").onclick = async () => {
    const r = await api("GET", `inspections/${ins.id}/report`);
    const box = $("#report-text");
    box.textContent = r.text;
    box.classList.remove("hidden");
    // 휴대폰 문자로 옮겨 적을 때 귀로 들으며 받아 쓰도록 천천히
    speak(sayable(r.text.replace("[급식 이상 보고]", "급식 이상 보고.").replace(/^(\d+)\)/gm, "$1번.").replace("※", "")));
  };
  $("#pdf").onclick = () => window.open(`/report?id=${ins.id}`, "_blank");
  $("#mark-reported").onclick = async () => {
    await api("POST", `inspections/${ins.id}/reported`);
    toast("보고 시각을 검수 기록에 남겼습니다.");
    renderReport();
  };
  void u;
}

function issueEditor(it, ins) {
  const cats = state.me.categories;
  const el = document.createElement("article");
  el.className = "card issue-card";
  const d = it.detail || {};
  const basisInfo = it.basis === "visual" ? "육안 이상" :
    `${esc(d.source_label || BASIS_LABEL[it.basis])}${it.grade ? ` · ${esc(it.grade)}` : ""}${d.reason ? ` · ${esc(d.reason)}` : ""}${d.test_item ? ` · ${esc(d.test_item)} ${esc(d.test_result || "")}` : ""}`;
  el.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <h3>${esc(it.name || "품목명 미기재")}</h3>
      <div class="row" style="gap:6px"><span class="muted small">앱 제안: ${esc(it.suggested)}</span> <span data-cat>${catBadge(it.final || it.suggested)}</span>
        <span data-mod>${it.modified ? `<span class="badge src">감독관 수정</span>` : ""}</span></div>
    </div>
    <div class="small muted">근거: ${basisInfo}</div>
    <div class="issue-grid">
      <label class="field">불량 식품명<input type="text" data-f="name" value="${esc(it.name)}"></label>
      <div class="row" style="gap:8px;align-items:flex-end">
        <label class="field grow" style="flex-basis:90px">수량<input type="text" inputmode="decimal" data-f="qty" value="${esc(it.qty)}" placeholder="예: 10"></label>
        <label class="field grow" style="flex-basis:90px">단위<input type="text" list="unit-list-r" data-f="unit" value="${esc(it.unit)}" placeholder="박스"></label>
      </div>
      <label class="field">납품업체<input type="text" value="${esc(ins.vendor)}" readonly></label>
      <label class="field">불량 유형<select data-f="defect_type">${state.me.defect_types.map((t) => `<option ${t === it.defect_type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
      <label class="field">제조사<input type="text" data-f="maker" value="${esc(it.maker)}"></label>
      <label class="field">제조일자<input type="text" data-f="mfg_date" value="${esc(it.mfg_date)}"></label>
      <label class="field">소비기한<input type="text" data-f="exp_date" value="${esc(it.exp_date)}"></label>
      <label class="field">분류 (건의)<select data-f="final">${cats.map((c) => `<option ${c === (it.final || it.suggested) ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
    </div>
    <label class="field">메모 (선택)<input type="text" data-f="memo" value="${esc(it.memo)}"></label>
    <datalist id="unit-list-r">${UNITS.map((u) => `<option value="${u}">`).join("")}</datalist>
    <div class="row">
      <span data-photo>${it.has_photo ? `<img class="photo-thumb" src="/api/items/${it.id}/photo?t=${Date.now()}" alt="첨부 사진">` : `<span class="muted small">사진 없음</span>`}</span>
      <button class="btn small" type="button" data-photo-cam>웹캠으로 찍기</button>
      <label class="btn small">${it.has_photo ? "사진 파일 바꾸기" : "사진 파일 첨부"}<input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" data-photo-in></label>
      ${it.has_photo ? `<button class="btn small" data-photo-del>사진 빼기</button>` : ""}
      <span class="muted small">사진은 PDF 보고서에만 들어갑니다.</span>
      <button class="btn small ghost" data-del style="margin-left:auto;color:var(--g1)">보고 목록에서 빼기</button>
    </div>`;
  $$("[data-f]", el).forEach((inp) => {
    inp.onchange = async () => {
      try {
        const upd = await api("PUT", `items/${it.id}`, { [inp.dataset.f]: inp.value });
        Object.assign(it, upd);
        $("[data-cat]", el).innerHTML = catBadge(upd.final || upd.suggested);
        $("[data-mod]", el).innerHTML = upd.modified ? `<span class="badge src">감독관 수정</span>` : "";
        if (inp.dataset.f === "name") $("h3", el).textContent = upd.name || "품목명 미기재";
        const box = $("#report-text");
        if (box) box.classList.add("hidden");
      } catch (e) { toast(e.message); }
    };
  });
  const upload = async (f) => {
    try {
      await api("POST", `items/${it.id}/photo`, undefined, f);
      it.has_photo = true;
      el.replaceWith(issueEditor(it, ins));
    } catch (err) { toast(err.message); }
  };
  $("[data-photo-cam]", el).onclick = async () => {
    const f = await captureFromCamera(`${it.name || "이상 품목"} 찍기`);
    if (f) upload(f);
  };
  $("[data-photo-in]", el).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await api("POST", `items/${it.id}/photo`, undefined, f);
      it.has_photo = true;
      el.replaceWith(issueEditor(it, ins));
    } catch (err) { toast(err.message); }
  };
  const pdel = $("[data-photo-del]", el);
  if (pdel) pdel.onclick = async () => {
    await api("DELETE", `items/${it.id}/photo`);
    it.has_photo = false;
    el.replaceWith(issueEditor(it, ins));
  };
  $("[data-del]", el).onclick = async () => {
    if (!confirm(`"${it.name}"을(를) 보고 목록과 검수 기록에서 뺄까요?`)) return;
    await api("DELETE", `items/${it.id}`);
    renderReport();
  };
  return el;
}

/* ------------------------------------------------------------ 검수 기록 */

async function renderRecords() {
  const main = $("#main");
  main.innerHTML = `<p class="muted">불러오는 중…</p>`;
  let r;
  try { r = await api("GET", "inspections"); } catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  main.innerHTML = `
  <section class="view">
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <h2>검수 기록 · ${r.items.length}회차</h2>
        <a class="btn" href="/api/export.csv" download>CSV 내보내기 (전체)</a>
      </div>
      ${r.items.length ? `<div class="table-scroll"><table class="list">
        <thead><tr><th>날짜·시간</th><th>납품업체</th><th>작성자</th><th>통과</th><th>이상</th><th>보고</th></tr></thead>
        <tbody>${r.items.map((i) => `<tr class="click" data-id="${i.id}" tabindex="0">
          <td>${esc(i.started_at.slice(0, 16))}</td><td>${esc(i.vendor)}</td><td>${esc(i.author)}</td>
          <td>${i.pass_count}건</td><td>${i.issue_count ? `<b style="color:var(--g1)">${i.issue_count}건</b>` : "0건"}</td>
          <td>${i.reported ? `<span class="badge pass">보고 ${esc((i.reported_at || "").slice(5, 16))}</span>` : i.issue_count ? `<span class="badge issue">보고 전</span>` : "-"}</td></tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty-art"><img src="img/truck.jpg" alt="식자재를 싣고 오는 납품 트럭 그림">
        <div class="stack"><p>아직 검수 기록이 없습니다. 납품 차량이 들어오면 검수 화면에서 품목을 조회해 기록하세요.</p>
        <div><a class="btn primary" href="#inspect">검수 화면으로</a></div></div></div>`}
    </div>
    <div id="record-detail"></div>
  </section>`;
  $$("tr[data-id]").forEach((tr) => {
    const open = () => showRecord(+tr.dataset.id);
    tr.onclick = open;
    tr.onkeydown = (e) => e.key === "Enter" && open();
  });
  if (state.records.openId) showRecord(state.records.openId);
}

async function showRecord(id) {
  state.records.openId = id;
  const box = $("#record-detail");
  let d;
  try { d = await api("GET", `inspections/${id}`); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const ins = d.inspection;
  box.innerHTML = `
  <div class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <h2>회차 ${ins.id} · ${esc(ins.vendor)} · ${esc(ins.started_at.slice(0, 16))}</h2>
      <div class="row">
        <a class="btn small" href="/api/export.csv?inspection=${ins.id}" download>이 회차 CSV</a>
        <a class="btn small" href="#report/${ins.id}">보고 화면 열기</a>
        <button class="btn small" id="re-pdf">PDF 다시 만들기</button>
      </div>
    </div>
    ${d.items.length ? `<div class="table-scroll"><table class="list">
      <thead><tr><th>품목명</th><th>결과</th><th>확인 방법</th><th>후보 대조</th><th>근거·등급</th><th>불량 유형</th><th>수량</th><th>분류</th><th>메모</th></tr></thead>
      <tbody>${d.items.map((it) => `<tr>
        <td>${esc(it.name)}${it.barcode ? `<div class="muted small">${esc(it.barcode)}</div>` : ""}</td>
        <td>${it.result === "pass" ? `<span class="badge pass">통과</span>` : `<span class="badge issue">이상</span>`}</td>
        <td>${esc(METHOD_LABEL[it.method] || it.method)}</td>
        <td>${esc(MATCH_LABEL[it.match] || "")}</td>
        <td>${esc(BASIS_LABEL[it.basis] || "")}${it.grade ? ` · ${esc(it.grade)}` : ""}</td>
        <td>${esc(it.result === "issue" ? it.defect_type : "")}</td>
        <td>${esc(it.qty)}${esc(it.unit)}</td>
        <td>${it.result === "issue" ? catBadge(it.final || it.suggested) + (it.modified ? ` <span class="badge src">감독관 수정</span>` : "") : ""}</td>
        <td class="small">${esc(it.memo)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">기록된 품목이 없습니다.</p>`}
  </div>`;
  $("#re-pdf").onclick = () => window.open(`/report?id=${ins.id}&at=reported`, "_blank");
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------------------------------------ 설정 */

async function renderSettings() {
  const r = await api("GET", "me");
  state.me = r;
  const u = r.user;
  const ms = [0, 1, 2].map((i) => r.managers[i] || { role: "", name: "", phone: "" });
  $("#main").innerHTML = `
  <section class="view">
    <form class="card stack" id="set-form">
      <h2>내 정보</h2>
      <div class="row">
        <label class="field grow">계급<input type="text" name="rank" list="ranks2" value="${esc(u.rank)}" required></label>
        <label class="field grow">성명<input type="text" name="name" value="${esc(u.name)}" required></label>
        <label class="field grow">부대 코드 (변경 불가)<input type="text" value="${esc(u.unit_code)}${r.unit.name ? ` · ${esc(r.unit.name)}` : ""}" readonly></label>
      </div>
      <datalist id="ranks2">${RANKS.map((x) => `<option value="${x}">`).join("")}</datalist>
      <p class="muted small">아이디: ${esc(u.username)}</p>
      <h2 style="margin-top:8px">관리자 (보고 받는 사람, 최대 3명)</h2>
      <p class="muted small">보고 문구에는 넣지 않고, 보고 화면에서 누구에게 보낼지 참고로 보여 줍니다. 베타는 가상 연락처만 넣으세요.</p>
      ${ms.map((m, i) => `
      <div class="row">
        <label class="field grow">직책 ${i + 1}<input type="text" name="role${i}" value="${esc(m.role)}" placeholder="예: 대대 급식 담당자"></label>
        <label class="field grow">성명<input type="text" name="mname${i}" value="${esc(m.name)}"></label>
        <label class="field grow">연락처<input type="text" name="phone${i}" value="${esc(m.phone)}" placeholder="010-0000-0000"></label>
      </div>`).join("")}
      <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">저장</button></div>
    </form>
    <div class="card stack" id="data-status"></div>
  </section>`;
  $("#set-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const managers = [0, 1, 2].map((i) => ({ role: f.get("role" + i), name: f.get("mname" + i), phone: f.get("phone" + i) }));
    try {
      await api("PUT", "settings", { rank: f.get("rank"), name: f.get("name"), managers });
      const me = await api("GET", "me");
      state.me = me;
      toast("저장했습니다.");
      render();
    } catch (err) { toast(err.message); }
  };
  renderDataStatus();
}

async function renderDataStatus() {
  const box = $("#data-status");
  if (!box) return;
  const st = state.status || (await api("GET", "status"));
  box.innerHTML = `
    <h2>자료 상태</h2>
    <div class="status-line" id="status-line">${statusText(st)}</div>
    <table class="list"><thead><tr><th>자료</th><th>건수</th><th>받은 시각</th></tr></thead>
      <tbody>${Object.keys(st.counts).map((k) => `<tr><td>${esc(st.labels[k])}</td><td>${st.counts[k].toLocaleString()}건</td><td>${esc(st.per_service[k] || "-")}</td></tr>`).join("")}</tbody></table>
    <p class="muted small">마지막 시도: ${esc(st.last_attempt || "-")} · I2640(농산물)은 I2620에 모두 들어 있어 따로 받지 않습니다. 인증키는 프로그램 폴더의 .env 파일에만 있습니다.</p>
    <div><button class="btn primary" id="refresh-now" ${st.refreshing ? "disabled" : ""}>${st.refreshing ? "자료 받는 중…" : "지금 자료 다시 받기"}</button></div>`;
  $("#refresh-now").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "자료 받는 중…";
    try {
      const r = await api("POST", "refresh");
      state.status = r.status;
      toast(r.ok ? "자료를 새로 받았습니다." : (r.status.error_msg || "자료를 받지 못했습니다. 마지막 자료를 씁니다."));
    } catch (err) { toast(err.message); }
    renderDataStatus();
  };
}

boot();
