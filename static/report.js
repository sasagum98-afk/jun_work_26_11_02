/* PDF 보고서 (인쇄 화면 → 브라우저 "PDF로 저장") */
"use strict";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const MATCH_LABEL = { none: "후보 없음", lot_match: "로트 일치", lot_mismatch: "후보 있었으나 로트 불일치" };
const METHOD_LABEL = { barcode: "바코드", ocr: "글자 인식", manual: "입력" };
const BASIS_LABEL = { I0490: "I0490 회수·판매중지", I2620: "I2620 검사부적합(국내)", I2715: "I2715 해외직구 위해식품(보조)" };

async function get(path) {
  const r = await fetch("/api/" + path);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "불러오지 못했습니다");
  return d;
}

async function main() {
  const qs = new URLSearchParams(location.search);
  const id = +qs.get("id");
  const at = qs.get("at") === "reported" ? "&at=reported" : "";
  const page = document.getElementById("page");
  let d, rep;
  try {
    d = await get(`inspections/${id}`);
    rep = await get(`inspections/${id}/report?x=1${at}`);
  } catch (e) {
    page.innerHTML = `<p>${esc(e.message)}</p>`;
    return;
  }
  const ins = d.inspection;
  const issues = d.items.filter((i) => i.result === "issue");
  const passes = d.items.filter((i) => i.result === "pass");
  const when = rep.text.split("\n")[1];
  document.title = `급식이상보고_${ins.unit_code}_${ins.started_at.slice(0, 10)}_회차${ins.id}`;
  page.innerHTML = `
    <h1>급식 식자재 이상 보고서</h1>
    <table class="meta">
      <tr><th>부대 코드</th><td>${esc(ins.unit_code)}${d.unit && d.unit.name ? ` (${esc(d.unit.name)})` : ""}</td><th>작성자</th><td>${esc(ins.author)}</td></tr>
      <tr><th>보고 일시</th><td>${esc(when)}</td><th>납품업체</th><td>${esc(ins.vendor)}</td></tr>
      <tr><th>검수 시작</th><td>${esc(ins.started_at.slice(0, 16))} (회차 ${ins.id})</td><th>검수 결과</th><td>통과 ${passes.length}건 / 이상 ${issues.length}건</td></tr>
    </table>

    <h2>보고 문구</h2>
    <pre>${esc(rep.text)}</pre>

    <h2>이상 품목 상세 (${issues.length}건)</h2>
    ${issues.length ? issues.map((it, n) => itemBlock(it, n + 1, ins)).join("") : "<p>이상 품목이 없습니다.</p>"}

    <h2>통과 품목 (${passes.length}건)</h2>
    ${passes.length ? `<table><thead><tr><th>번호</th><th>품목명</th><th>바코드</th><th>확인 방법</th><th>후보 대조</th><th>메모</th></tr></thead><tbody>
      ${passes.map((it, n) => `<tr><td>${n + 1}</td><td>${esc(it.name)}</td><td>${esc(it.barcode)}</td><td>${esc(METHOD_LABEL[it.method] || "")}</td>
        <td>${esc(MATCH_LABEL[it.match] || "")}</td><td>${esc(it.memo)}</td></tr>`).join("")}</tbody></table>` : "<p>통과 품목이 없습니다.</p>"}

    <div class="note">
      ※ 이 보고서의 분류(회수 / 급식중단 / 보고 후 결정)는 앱의 제안이며, 실제 조치는 관리자와 지휘계통이 결정합니다.<br>
      ※ 식품안전나라 회수·부적합 이력과 대조한 결과이며, 검사를 대체하지 않습니다. 이력이 없다는 것은 안전 판정이 아닙니다.<br>
      ※ 베타 버전: 가상 부대 정보만 사용합니다.
    </div>`;
  const imgs = [...page.querySelectorAll("img")];
  // 제품 사진을 받지 못하면(인터넷 끊김·사진 없음) 빈 칸 대신 지움
  const drop = (img) => (img.closest("figure") || img).remove();
  await Promise.all(imgs.map((img) => {
    if (img.complete) {
      if (!img.naturalWidth) drop(img);
      return null;
    }
    return new Promise((ok) => {
      img.onload = ok;
      img.onerror = () => { drop(img); ok(); };
    });
  }));
  document.getElementById("print").onclick = () => window.print();
  setTimeout(() => window.print(), 300);
}

function itemBlock(it, n, ins) {
  const d = it.detail || {};
  const rows = [
    ["불량 식품명", esc(it.name)],
    ["수량", esc(it.qty ? it.qty + it.unit : "미기재")],
    ["납품업체", esc(ins.vendor)],
    ["불량 유형", esc(it.defect_label)],
    ["근거", esc(it.basis === "visual" ? "육안 확인" : d.source_label || BASIS_LABEL[it.basis] || it.basis)],
  ];
  if (it.grade) rows.push(["등급", esc(it.grade)]);
  if (d.reason) rows.push([it.basis === "I2715" ? "문제 성분" : "회수 사유", esc(d.reason)]);
  if (d.test_item) rows.push(["부적합 항목", esc([d.test_item, d.test_result && `결과 ${d.test_result}`, d.standard && `기준 ${d.standard}`].filter(Boolean).join(" · "))]);
  rows.push(["제조사", esc(it.maker || "-")], ["제조일자", esc(it.mfg_date || "-")], ["소비기한", esc(it.exp_date || "-")]);
  rows.push(["후보 대조", esc(MATCH_LABEL[it.match] || "-")]);
  rows.push(["분류(건의)", `<b class="${(it.final || it.suggested) === "급식중단" ? "stop" : ""}">${esc(it.final || it.suggested)}</b> (앱 제안: ${esc(it.suggested)}${it.modified ? ", 감독관 수정" : ""})`]);
  if (it.memo) rows.push(["메모", esc(it.memo)]);
  return `<div class="item">
    <div class="head"><span>${n}) ${esc(it.name)}</span><span>건의: ${esc(it.final || it.suggested)}</span></div>
    <table>${rows.map(([k, v]) => `<tr><th style="width:28mm">${k}</th><td>${v}</td></tr>`).join("")}</table>
    <div class="photos">
      ${it.has_photo ? `<figure><img src="/api/items/${it.id}/photo" alt="${esc(it.name)} 현장 사진"><figcaption>현장 사진</figcaption></figure>` : ""}
      ${(it.basis === "I0490" || it.basis === "I2715") && it.source_seq ? `<figure class="prod"><img src="/api/image?src=${it.basis}&seq=${encodeURIComponent(it.source_seq)}&i=0" alt="${esc(it.name)} 제품 사진">
        <figcaption>제품 사진 (출처: 식품안전나라)</figcaption></figure>` : ""}
    </div>
  </div>`;
}

main();
