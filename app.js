/* ルート表 — 有料老人ホーム 曜日別ルート表アプリ
 * データ: Supabase（config.js 設定時） / デモモード（localStorage）
 */
(() => {
"use strict";

const CFG = window.ROUTE_CONFIG || {};
const WD = ["月", "火", "水", "木", "金", "土", "日"];
const SLOTS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const RANGES = {
  all:   [["00:00", "23:30"]],
  day:   [["09:00", "18:00"]],
  night: [["16:30", "23:30"]],
  early: [["00:00", "09:30"]],
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slotLabel = (s) => s.replace(/^0/, "");
const inRange = (s, [a, b]) => s >= a && s <= b;

// ---------------------------------------------------------------- store
class LocalStore {
  constructor() { this.key = "route-hyo-demo-v1"; this.db = JSON.parse(localStorage.getItem(this.key) || "null") || this.seed(); }
  seed() {
    const d = window.ROUTE_DEMO_DATA, db = { seq: 1, route_categories: [], route_items: [], route_residents: [], route_entries: [], route_day_notes: [] };
    const id = () => db.seq++;
    const cat = {}, item = {}, res = {};
    d.categories.forEach((c) => { const r = { id: id(), ...c }; db.route_categories.push(r); cat[c.name] = r.id; });
    d.items.forEach((it, i) => { const r = { id: id(), category_id: cat[it.category], name: it.name, sort: i, active: true }; db.route_items.push(r); item[it.category + "|" + it.name] = r.id; });
    d.residents.forEach((p, i) => { const r = { id: id(), room: p.room, name: p.name, sort: i, active: true }; db.route_residents.push(r); res[p.room + "|" + p.name] = r.id; });
    d.entries.forEach((e) => db.route_entries.push({ id: id(), resident_id: res[e.room + "|" + e.name], weekday: e.weekday, slot: e.slot, item_id: item[e.category + "|" + e.item] }));
    Object.entries(d.notes || {}).forEach(([w, n]) => db.route_day_notes.push({ weekday: +w, note: n }));
    return db;
  }
  save() { localStorage.setItem(this.key, JSON.stringify(this.db)); }
  reset() { localStorage.removeItem(this.key); this.db = this.seed(); this.save(); }
  async list(t) { return structuredClone(this.db[t]); }
  async insert(t, row) { const r = { id: this.db.seq++, ...row }; this.db[t].push(r); this.save(); return structuredClone(r); }
  async update(t, id, patch) { const r = this.db[t].find((x) => x.id === id); Object.assign(r, patch); this.save(); return structuredClone(r); }
  async remove(t, match) {
    const ok = (r) => Object.entries(match).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v);
    if (t === "route_residents") { const ids = this.db[t].filter(ok).map((r) => r.id); this.db.route_entries = this.db.route_entries.filter((e) => !ids.includes(e.resident_id)); }
    if (t === "route_categories") { const ids = this.db[t].filter(ok).map((r) => r.id); this.db.route_items = this.db.route_items.filter((e) => !ids.includes(e.category_id)); }
    if (t === "route_items" && this.db.route_entries.some((e) => ok({ id: e.item_id }) )) throw new Error("この項目はルート表で使われています");
    this.db[t] = this.db[t].filter((r) => !ok(r)); this.save();
  }
  async upsert(t, rows, keys) {
    const out = [];
    for (const row of rows) {
      const ex = this.db[t].find((r) => keys.every((k) => r[k] === row[k]));
      if (ex) { Object.assign(ex, row); out.push(structuredClone(ex)); }
      else { const r = t === "route_day_notes" ? { ...row } : { id: this.db.seq++, ...row }; this.db[t].push(r); out.push(structuredClone(r)); }
    }
    this.save(); return out;
  }
}

class SupaStore {
  constructor(client) { this.c = client; }
  chk({ data, error }) { if (error) throw new Error(error.message); return data; }
  async list(t) {
    const all = []; let from = 0;
    for (;;) { // 1000件ずつ取得
      const rows = this.chk(await this.c.from(t).select("*").range(from, from + 999));
      all.push(...rows); if (rows.length < 1000) break; from += 1000;
    }
    return all;
  }
  async insert(t, row) { return this.chk(await this.c.from(t).insert(row).select().single()); }
  async update(t, id, patch) { return this.chk(await this.c.from(t).update(patch).eq("id", id).select().single()); }
  async remove(t, match) {
    let q = this.c.from(t).delete();
    for (const [k, v] of Object.entries(match)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
    const { error } = await q;
    if (error) throw new Error(error.code === "23503" ? "この項目はルート表で使われています" : error.message);
  }
  async upsert(t, rows, keys) {
    if (!rows.length) return [];
    return this.chk(await this.c.from(t).upsert(rows, { onConflict: keys.join(",") }).select());
  }
}

// ---------------------------------------------------------------- state
const S = { store: null, demo: false, cats: [], items: [], residents: [], entries: new Map(), notes: {}, wd: 0, range: "all", view: "edit" };
const ekey = (rid, wd, slot) => `${rid}|${wd}|${slot}`;
const catById = (id) => S.cats.find((c) => c.id === id);
const itemById = (id) => S.items.find((i) => i.id === id);
const sortedCats = () => [...S.cats].sort((a, b) => a.sort - b.sort || a.id - b.id);
const itemsOf = (cid) => S.items.filter((i) => i.category_id === cid).sort((a, b) => a.sort - b.sort || a.id - b.id);
const roomNum = (r) => { const n = parseFloat(r); return isNaN(n) ? Infinity : n; };
const activeResidents = () => S.residents.filter((r) => r.active).sort((a, b) => roomNum(a.room) - roomNum(b.room) || String(a.room).localeCompare(b.room) || a.sort - b.sort);
const textColor = (hex) => { const h = (hex || "#fff").replace("#", ""); const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16)); return (r * 299 + g * 587 + b * 114) / 1000 < 140 ? "#fff" : "#1f2933"; };

function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 5000 : 1600);
}
async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { console.error(e); toast("保存できませんでした：" + e.message, true); await loadAll(); render(); }
}

async function loadAll() {
  const [cats, items, residents, entries, notes] = await Promise.all(
    ["route_categories", "route_items", "route_residents", "route_entries", "route_day_notes"].map((t) => S.store.list(t)));
  S.cats = cats; S.items = items; S.residents = residents;
  S.entries = new Map(entries.map((e) => [ekey(e.resident_id, e.weekday, e.slot), e]));
  S.notes = Object.fromEntries(notes.map((n) => [n.weekday, n.note]));
}

// ---------------------------------------------------------------- views
function show(view) {
  S.view = view;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
  render();
}
function render() {
  if (S.view === "edit") renderEdit();
  if (S.view === "residents") renderResidents();
  if (S.view === "master") renderMaster();
  if (S.view === "print") renderPrint();
}

function legendHTML() {
  return sortedCats().map((c) => `<span class="chip" style="background:${esc(c.color)};color:${textColor(c.color)}">${esc(c.name)}</span>`).join("");
}

function optionsHTML(selId) {
  let html = `<option value="">（空欄）</option>`;
  for (const c of sortedCats()) {
    const its = itemsOf(c.id).filter((i) => i.active || i.id === selId);
    if (!its.length) continue;
    html += `<optgroup label="${esc(c.name)}">` + its.map((i) => `<option value="${i.id}"${i.id === selId ? " selected" : ""}>${esc(i.name)}</option>`).join("") + `</optgroup>`;
  }
  return html;
}

// ---- 編集
function renderEdit() {
  $("#wd-tabs").innerHTML = WD.map((w, i) => `<button data-wd="${i}" class="${i === S.wd ? "active" : ""}">${w}</button>`).join("");
  $$("#range-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.range === S.range));
  $("#edit-legend").innerHTML = "区分：" + legendHTML();
  const res = activeResidents();
  const slots = SLOTS.filter((s) => RANGES[S.range].some((r) => inRange(s, r)));
  const g = $("#edit-grid");
  if (!res.length) { g.innerHTML = `<tr><td class="empty">利用者が登録されていません。「利用者」タブから追加してください。</td></tr>`; return; }
  let h = `<thead><tr><th class="tcol">部屋</th>${res.map((r) => `<th class="room">${esc(r.room)}</th>`).join("")}</tr>`;
  h += `<tr><th class="tcol">名前</th>${res.map((r) => `<th class="name">${esc(r.name)}<button class="mini" data-copy-res="${r.id}" title="${esc(r.name)}さんの予定を他の曜日へコピー">⇄</button></th>`).join("")}</tr></thead><tbody>`;
  for (const s of slots) {
    const hour = s.endsWith(":00");
    h += `<tr class="${hour ? "hour" : "half"}"><th class="tcol">${slotLabel(s)}</th>`;
    for (const r of res) {
      const e = S.entries.get(ekey(r.id, S.wd, s));
      const it = e && itemById(e.item_id), c = it && catById(it.category_id);
      const st = c ? ` style="background:${esc(c.color)};color:${textColor(c.color)}"` : "";
      h += `<td${st}><select class="${it ? "" : "blank"}" data-rid="${r.id}" data-slot="${s}"${st}>${optionsHTML(it ? it.id : null)}</select></td>`;
    }
    h += `</tr>`;
  }
  g.innerHTML = h + `</tbody>`;
  $("#day-note").value = S.notes[S.wd] || "";
}

async function setEntry(rid, wd, slot, itemId) {
  const k = ekey(rid, wd, slot);
  if (!itemId) {
    await S.store.remove("route_entries", { resident_id: rid, weekday: wd, slot });
    S.entries.delete(k);
  } else {
    const [row] = await S.store.upsert("route_entries", [{ resident_id: rid, weekday: wd, slot, item_id: itemId }], ["resident_id", "weekday", "slot"]);
    S.entries.set(k, row);
  }
}

async function copyEntries({ residentIds, from, to, clear }) {
  const rows = [];
  for (const t of to) {
    if (t === from) continue;
    if (clear) await S.store.remove("route_entries", { resident_id: residentIds, weekday: t });
    for (const rid of residentIds) for (const s of SLOTS) {
      const e = S.entries.get(ekey(rid, from, s));
      if (e) rows.push({ resident_id: rid, weekday: t, slot: s, item_id: e.item_id });
    }
  }
  await S.store.upsert("route_entries", rows, ["resident_id", "weekday", "slot"]);
  await loadAll();
}

function openCopyDialog({ title, desc, residentIds, from }) {
  const d = $("#dlg-copy");
  $("#dlg-copy-title").textContent = title; $("#dlg-copy-desc").textContent = desc;
  $("#dlg-copy-days").innerHTML = WD.map((w, i) => i === from ? "" : `<label><input type="checkbox" value="${i}"> ${w}</label>`).join("") +
    `<button type="button" class="ghost small" id="dlg-all">全部</button>`;
  $("#dlg-all").onclick = () => $$("#dlg-copy-days input").forEach((c) => (c.checked = true));
  d.onclose = async () => {
    if (d.returnValue !== "ok") return;
    const to = $$("#dlg-copy-days input:checked").map((c) => +c.value);
    if (!to.length) return toast("コピー先の曜日を選んでください", true);
    await guard(() => copyEntries({ residentIds, from, to, clear: $("#dlg-copy-clear").checked }), `${to.map((i) => WD[i]).join("・")}曜日にコピーしました`);
    render();
  };
  d.returnValue = ""; d.showModal();
}

// ---- 利用者
function renderResidents() {
  const list = [...S.residents].sort((a, b) => (b.active - a.active) || roomNum(a.room) - roomNum(b.room));
  $("#nr-copy").innerHTML = `<option value="">コピーしない（空で作る）</option>` +
    activeResidents().map((r) => `<option value="${r.id}">${esc(r.room)} ${esc(r.name)}さんと同じ予定で作る</option>`).join("");
  const cnt = (rid) => [...S.entries.values()].filter((e) => e.resident_id === rid).length;
  $("#resident-list").innerHTML = `<tr><th>部屋</th><th>名前</th><th>予定の数</th><th>表示</th><th></th></tr>` + list.map((r) => `
    <tr data-id="${r.id}" class="${r.active ? "" : "inactive"}">
      <td><input class="room-in" value="${esc(r.room)}" data-f="room"></td>
      <td><input value="${esc(r.name)}" data-f="name"></td>
      <td class="num">${cnt(r.id)}</td>
      <td><label class="switch"><input type="checkbox" data-f="active"${r.active ? " checked" : ""}> ${r.active ? "表示中" : "非表示"}</label></td>
      <td><button class="danger small" data-del-res="${r.id}">削除</button></td>
    </tr>`).join("");
}

// ---- 項目・色
function renderMaster() {
  const used = new Set([...S.entries.values()].map((e) => e.item_id));
  $("#cat-cards").innerHTML = sortedCats().map((c) => `
    <div class="card cat-card" data-cid="${c.id}">
      <div class="cat-head" style="background:${esc(c.color)};color:${textColor(c.color)}">
        <input class="cat-name" value="${esc(c.name)}" data-cf="name" style="color:inherit">
        <label class="color-pick" title="色を選ぶ">色 <input type="color" value="${esc(c.color)}" data-cf="color"></label>
      </div>
      <ul class="items">${itemsOf(c.id).map((i, n, arr) => `
        <li data-iid="${i.id}" class="${i.active ? "" : "inactive"}">
          <input value="${esc(i.name)}" data-if="name">
          <span class="ops">
            <button class="mini" data-move="-1" ${n === 0 ? "disabled" : ""} title="上へ">↑</button>
            <button class="mini" data-move="1" ${n === arr.length - 1 ? "disabled" : ""} title="下へ">↓</button>
            <label class="mini-chk" title="外すとプルダウンに出なくなります"><input type="checkbox" data-if="active"${i.active ? " checked" : ""}>使う</label>
            <button class="mini danger" data-del-item="${i.id}" ${used.has(i.id) ? "disabled title='ルート表で使われているため削除できません（「使う」を外すと非表示にできます）'" : "title='削除'"}>✕</button>
          </span>
        </li>`).join("")}
      </ul>
      <form class="add-item"><input placeholder="項目を追加（例：吸引）" required><button class="ghost small">追加</button></form>
      ${itemsOf(c.id).length ? "" : `<button class="danger small" data-del-cat="${c.id}">この区分を削除</button>`}
    </div>`).join("");
}

// ---- 印刷
function pageRows(shift, wd) {
  if (shift === "day") return SLOTS.filter((s) => inRange(s, ["09:00", "18:00"])).map((s) => ({ wd, s, label: slotLabel(s) }));
  const a = SLOTS.filter((s) => s >= "16:30").map((s) => ({ wd, s, label: slotLabel(s) }));
  const nw = (wd + 1) % 7;
  const b = SLOTS.filter((s) => s <= "09:30").map((s, i) => ({ wd: nw, s, label: (i === 0 ? "翌" : "") + slotLabel(s), next: i === 0 }));
  return a.concat(b);
}
function renderPrint() {
  if (!$("#p-days").children.length)
    $("#p-days").innerHTML = WD.map((w, i) => `<label><input type="checkbox" value="${i}" checked> ${w}</label>`).join("");
  const shift = $("input[name=p-shift]:checked").value, paper = $("input[name=p-paper]:checked").value;
  const color = $("#p-color").checked;
  const days = $$("#p-days input:checked").map((c) => +c.value);
  const land = shift === "day";
  const [W, H] = paper === "A3" ? (land ? [420, 297] : [297, 420]) : (land ? [297, 210] : [210, 297]);
  const M = 8, k = paper === "A3" ? 1.414 : 1;
  $("#page-style").textContent = `@page { size: ${paper} ${land ? "landscape" : "portrait"}; margin: ${M}mm; }`;
  const res = activeResidents();
  const today = new Date(), stamp = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()} 印刷`;
  const title = land ? "日中 9:00〜18:00" : "夜勤 16:30〜翌9:30";
  const html = days.map((wd) => {
    const rows = pageRows(shift, wd);
    const note = shift === "day" ? (S.notes[wd] || "") : [S.notes[wd], S.notes[(wd + 1) % 7] ? `（翌${WD[(wd + 1) % 7]}）${S.notes[(wd + 1) % 7]}` : ""].filter(Boolean).join("　");
    let t = `<table class="ptable"><colgroup><col class="pt-time">${res.map(() => "<col>").join("")}</colgroup>
      <thead><tr class="p-room"><th>部屋</th>${res.map((r) => `<th>${esc(r.room)}</th>`).join("")}</tr>
      <tr class="p-name"><th>名前</th>${res.map((r) => `<th>${esc(r.name)}</th>`).join("")}</tr></thead><tbody>`;
    for (const row of rows) {
      const hour = row.s.endsWith(":00");
      t += `<tr class="${hour ? "hour" : "half"}${row.next ? " nextday" : ""}"><th>${row.label}</th>`;
      for (const r of res) {
        const e = S.entries.get(ekey(r.id, row.wd, row.s));
        const it = e && itemById(e.item_id), c = it && catById(it.category_id);
        t += `<td${c && color ? ` style="background:${esc(c.color)};color:${textColor(c.color)}"` : ""}>${it ? esc(it.name) : ""}</td>`;
      }
      t += `</tr>`;
    }
    t += `</tbody></table>`;
    return `<div class="sheet ${land ? "land" : "port"}" style="width:${W - 2 * M}mm;height:${H - 2 * M - 1}mm;--k:${k}">
      <div class="p-head"><div class="p-title">${WD[wd]}曜日　${title}</div>
        <div class="p-legend">${color ? legendHTML() : ""}</div><div class="p-stamp">${esc(CFG.FACILITY_NAME || "")}　${stamp}</div></div>
      <div class="p-body">${t}</div>
      ${note ? `<div class="p-note">メモ：${esc(note)}</div>` : ""}
    </div>`;
  }).join("");
  $("#print-area").innerHTML = html || `<p class="hint">曜日を選んでください。</p>`;
  fitText();
}
// はみ出す文字は自動で小さくする
function fitText() {
  for (const el of $$("#print-area td, #print-area thead th")) {
    if (!el.textContent) continue;
    let fs = parseFloat(getComputedStyle(el).fontSize), n = 0;
    while (el.scrollWidth > el.clientWidth + 0.5 && n++ < 30 && fs > 5) { fs *= 0.94; el.style.fontSize = fs + "px"; }
  }
}

// ---------------------------------------------------------------- events
function bind() {
  $("#tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.view); };
  $("#btn-reload").onclick = async () => { await guard(loadAll); render(); toast("最新の内容にしました"); };
  $("#wd-tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) { S.wd = +b.dataset.wd; renderEdit(); } };
  $("#range-tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) { S.range = b.dataset.range; renderEdit(); } };

  $("#edit-grid").addEventListener("change", async (e) => {
    const sel = e.target.closest("select"); if (!sel) return;
    const rid = +sel.dataset.rid, slot = sel.dataset.slot, iid = sel.value ? +sel.value : null;
    const td = sel.parentElement, c = iid && catById(itemById(iid).category_id);
    const st = c ? `background:${c.color};color:${textColor(c.color)}` : "";
    td.style.cssText = st; sel.style.cssText = st; sel.classList.toggle("blank", !iid);
    await guard(() => setEntry(rid, S.wd, slot, iid), "保存しました");
  });
  $("#edit-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy-res]"); if (!b) return;
    const r = S.residents.find((x) => x.id === +b.dataset.copyRes);
    openCopyDialog({ title: `${r.name}さんの予定をコピー`, desc: `${WD[S.wd]}曜日の${r.name}さんの予定を、選んだ曜日にコピーします。`, residentIds: [r.id], from: S.wd });
  });
  $("#btn-copy-day").onclick = () => openCopyDialog({ title: `${WD[S.wd]}曜日をコピー`, desc: `${WD[S.wd]}曜日の全員分の予定を、選んだ曜日にコピーします。`, residentIds: activeResidents().map((r) => r.id), from: S.wd });
  $("#day-note").addEventListener("change", async (e) => {
    const note = e.target.value.trim(), wd = S.wd;
    await guard(async () => { await S.store.upsert("route_day_notes", [{ weekday: wd, note }], ["weekday"]); S.notes[wd] = note; }, "メモを保存しました");
  });

  // 利用者
  $("#add-resident").onsubmit = async (e) => {
    e.preventDefault();
    const room = $("#nr-room").value.trim(), name = $("#nr-name").value.trim(), src = +$("#nr-copy").value || null;
    if (S.residents.some((r) => r.active && r.room === room) && !confirm(`${room}号室には表示中の利用者がいます。追加しますか？`)) return;
    await guard(async () => {
      const r = await S.store.insert("route_residents", { room, name, sort: S.residents.length, active: true });
      if (src) {
        const rows = [...S.entries.values()].filter((x) => x.resident_id === src).map((x) => ({ resident_id: r.id, weekday: x.weekday, slot: x.slot, item_id: x.item_id }));
        await S.store.upsert("route_entries", rows, ["resident_id", "weekday", "slot"]);
      }
      await loadAll();
    }, `${name}さんを追加しました`);
    e.target.reset(); renderResidents();
  };
  $("#resident-list").addEventListener("change", async (e) => {
    const tr = e.target.closest("tr[data-id]"); if (!tr) return;
    const id = +tr.dataset.id, f = e.target.dataset.f;
    const v = f === "active" ? e.target.checked : e.target.value.trim();
    if (f !== "active" && !v) return renderResidents();
    await guard(async () => { const r = await S.store.update("route_residents", id, { [f]: v }); Object.assign(S.residents.find((x) => x.id === id), r); }, "保存しました");
    renderResidents();
  });
  $("#resident-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del-res]"); if (!b) return;
    const r = S.residents.find((x) => x.id === +b.dataset.delRes);
    if (!confirm(`${r.room} ${r.name}さんを削除します。\nこの方の予定もすべて消えます（元に戻せません）。\n\n予定を残したい場合は「表示」を外してください。`)) return;
    await guard(async () => { await S.store.remove("route_residents", { id: r.id }); await loadAll(); }, "削除しました");
    renderResidents();
  });

  // 項目・色
  const mc = $("#cat-cards");
  mc.addEventListener("input", (e) => { // 色はその場でプレビュー
    if (e.target.dataset.cf === "color") { const h = e.target.closest(".cat-head"); h.style.background = e.target.value; h.style.color = textColor(e.target.value); }
  });
  mc.addEventListener("change", async (e) => {
    const card = e.target.closest("[data-cid]"); if (!card) return;
    const cid = +card.dataset.cid;
    if (e.target.dataset.cf) {
      const f = e.target.dataset.cf, v = f === "color" ? e.target.value.toUpperCase() : e.target.value.trim();
      if (!v) return renderMaster();
      await guard(async () => { const r = await S.store.update("route_categories", cid, { [f]: v }); Object.assign(catById(cid), r); }, "保存しました");
      return renderMaster();
    }
    const li = e.target.closest("[data-iid]");
    if (li && e.target.dataset.if) {
      const iid = +li.dataset.iid, f = e.target.dataset.if, v = f === "active" ? e.target.checked : e.target.value.trim();
      if (f === "name" && !v) return renderMaster();
      await guard(async () => { const r = await S.store.update("route_items", iid, { [f]: v }); Object.assign(itemById(iid), r); }, "保存しました");
      renderMaster();
    }
  });
  mc.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-cid]"); if (!card) return;
    const cid = +card.dataset.cid;
    const mv = e.target.closest("[data-move]");
    if (mv) {
      const list = itemsOf(cid), i = list.findIndex((x) => x.id === +mv.closest("[data-iid]").dataset.iid), j = i + +mv.dataset.move;
      [list[i], list[j]] = [list[j], list[i]];
      await guard(async () => { for (let n = 0; n < list.length; n++) if (list[n].sort !== n) { await S.store.update("route_items", list[n].id, { sort: n }); list[n].sort = n; } });
      return renderMaster();
    }
    const di = e.target.closest("[data-del-item]");
    if (di) {
      const it = itemById(+di.dataset.delItem);
      if (!confirm(`「${it.name}」を削除しますか？`)) return;
      await guard(async () => { await S.store.remove("route_items", { id: it.id }); S.items = S.items.filter((x) => x.id !== it.id); }, "削除しました");
      return renderMaster();
    }
    const dc = e.target.closest("[data-del-cat]");
    if (dc && confirm(`区分「${catById(cid).name}」を削除しますか？`)) {
      await guard(async () => { await S.store.remove("route_categories", { id: cid }); S.cats = S.cats.filter((c) => c.id !== cid); }, "削除しました");
      renderMaster();
    }
  });
  mc.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cid = +e.target.closest("[data-cid]").dataset.cid, inp = e.target.querySelector("input"), name = inp.value.trim();
    if (itemsOf(cid).some((i) => i.name === name)) return toast("同じ名前の項目がすでにあります", true);
    await guard(async () => { const r = await S.store.insert("route_items", { category_id: cid, name, sort: Math.max(-1, ...itemsOf(cid).map((i) => i.sort)) + 1, active: true }); S.items.push(r); }, `「${name}」を追加しました`);
    renderMaster();
    $(`[data-cid="${cid}"] .add-item input`)?.focus();
  });
  $("#add-cat").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#nc-name").value.trim(), color = $("#nc-color").value.toUpperCase();
    await guard(async () => { const r = await S.store.insert("route_categories", { name, color, sort: S.cats.length }); S.cats.push(r); }, "区分を追加しました");
    e.target.reset(); renderMaster();
  };

  // 印刷
  $("#view-print").addEventListener("change", (e) => { if (e.target.closest(".print-opts")) renderPrint(); });
  $("#btn-print").onclick = () => { renderPrint(); window.print(); };
}

// ---------------------------------------------------------------- boot
function loadScript(src) { return new Promise((ok, ng) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ng(new Error("読み込み失敗: " + src)); document.head.appendChild(s); }); }

async function start() {
  await loadAll();
  $(".topbar nav").hidden = false;
  show(S.view);
}

async function boot() {
  $("#facility").textContent = CFG.FACILITY_NAME || "";
  bind();
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    S.demo = true; S.store = new LocalStore();
    $("#demo-banner").hidden = false; $("#btn-logout").hidden = true; $("#user-label").textContent = "デモ";
    $("#btn-demo-reset").onclick = async () => { if (confirm("デモのデータを初期状態に戻しますか？")) { S.store.reset(); await start(); } };
    return start();
  }
  await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
  const client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  S.store = new SupaStore(client);
  const showLogin = () => { $$(".view").forEach((v) => (v.hidden = v.id !== "view-login")); $("#tabs").hidden = true; $(".user").hidden = true; };
  const enter = async (session) => {
    $("#tabs").hidden = false; $(".user").hidden = false;
    $("#user-label").textContent = session.user.email;
    try { await start(); } catch (e) { toast("読み込めませんでした：" + e.message, true); }
  };
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault(); $("#login-msg").textContent = "";
    const { data, error } = await client.auth.signInWithPassword({ email: $("#login-email").value, password: $("#login-pass").value });
    if (error) { $("#login-msg").textContent = "ログインできませんでした（" + error.message + "）"; return; }
    enter(data.session);
  };
  $("#btn-logout").onclick = async () => { await client.auth.signOut(); showLogin(); };
  const { data: { session } } = await client.auth.getSession();
  session ? enter(session) : showLogin();
}

boot().catch((e) => { console.error(e); toast("起動できませんでした：" + e.message, true); });
})();
