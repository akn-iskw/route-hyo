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
  async list(t) { return structuredClone(this.db[t] || []); }
  async latest(t) { const l = this.db[t] || []; return l.length ? structuredClone(l[l.length - 1]) : null; }
  async insert(t, row) { const r = { id: this.db.seq++, ...row }; (this.db[t] ||= []).push(r); this.save(); return structuredClone(r); }
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
  async latest(t) { const r = this.chk(await this.c.from(t).select("*").order("id", { ascending: false }).limit(1)); return r[0] || null; }
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
const S = { store: null, demo: false, user: "", cats: [], items: [], residents: [], entries: new Map(), notes: {}, pub: null, wd: 0, range: "all", view: "edit" };
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
  S.pub = await S.store.latest("route_published");
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
  if (S.view === "kakutei") renderKakutei();
  if (S.view === "edit") renderKakuteiStatus();
}

function legendHTML(cats = sortedCats()) {
  return cats.map((c) => `<span class="chip" style="background:${esc(c.color)};color:${textColor(c.color)}">${esc(c.name)}</span>`).join("");
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

// ---- 確定（スナップショット）
function makeSnapshot() {
  const res = activeResidents();
  const rids = new Set(res.map((r) => r.id));
  return {
    cats: sortedCats().map(({ id, name, color, sort }) => ({ id, name, color, sort })),
    items: S.items.map(({ id, category_id, name }) => ({ id, category_id, name })),
    residents: res.map(({ id, room, name }) => ({ id, room, name })),
    entries: [...S.entries.values()].filter((e) => rids.has(e.resident_id))
      .map((e) => [e.resident_id, e.weekday, e.slot, e.item_id]).sort((x, y) => String(x).localeCompare(String(y))),
    notes: Object.fromEntries(Object.entries(S.notes).filter(([, v]) => v)),
  };
}
// 確定版との差分
function pendingChanges() {
  const cur = makeSnapshot();
  if (!S.pub) return { first: true, entries: cur.entries.length, other: [] };
  const old = S.pub.data;
  const nameOf = (d) => { const m = new Map(d.items.map((i) => [i.id, i])); const c = new Map(d.cats.map((x) => [x.id, x.name])); return (id) => { const i = m.get(id); return i ? c.get(i.category_id) + "/" + i.name : ""; }; };
  const n1 = nameOf(old), n2 = nameOf(cur);
  const m1 = new Map(old.entries.map(([r, w, s, i]) => [`${r}|${w}|${s}`, n1(i)]));
  const m2 = new Map(cur.entries.map(([r, w, s, i]) => [`${r}|${w}|${s}`, n2(i)]));
  let entries = 0;
  for (const k of new Set([...m1.keys(), ...m2.keys()])) if (m1.get(k) !== m2.get(k)) entries++;
  const other = [];
  const resKey = (d) => d.residents.map((r) => `${r.id}:${r.room}:${r.name}`).join(",");
  if (resKey(old) !== resKey(cur)) other.push("利用者");
  const catKey = (d) => d.cats.map((c) => `${c.id}:${c.name}:${String(c.color).toUpperCase()}`).join(",");
  if (catKey(old) !== catKey(cur)) other.push("区分・色");
  if (JSON.stringify(old.notes || {}) !== JSON.stringify(cur.notes)) other.push("メモ");
  return { first: false, entries, other };
}
function fmtTime(ts) { const d = new Date(ts); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; }
function renderKakuteiStatus() {
  const p = pendingChanges(), el = $("#kakutei-status"), bar = $("#kakutei-bar");
  const last = S.pub ? `最終確定：${fmtTime(S.pub.published_at)}（${esc(S.pub.published_by || "")}）` : "まだ一度も確定していません";
  const dirty = p.first || p.entries || p.other.length;
  bar.classList.toggle("dirty", !!dirty);
  el.innerHTML = dirty
    ? `<b>未確定の変更があります</b>${p.first ? "" : `（予定 ${p.entries}件${p.other.length ? "・" + p.other.join("・") : ""}）`}　<span class="muted">${last}</span>`
    : `<b>確定版と同じ内容です</b>　<span class="muted">${last}</span>`;
  $("#btn-kakutei").disabled = !dirty;
}
async function doKakutei() {
  const p = pendingChanges();
  const msg = p.first ? "今の内容を確定版にします。よろしいですか？"
    : `今の内容で確定版を更新します。\n（予定の変更 ${p.entries}件${p.other.length ? "／" + p.other.join("・") + "の変更" : ""}）\n\n確定すると「ルート表（確定）」と印刷に反映されます。`;
  if (!confirm(msg)) return;
  await guard(async () => {
    await loadAll(); // 他の人の編集も含めて最新で確定
    S.pub = await S.store.insert("route_published", { published_at: new Date().toISOString(), published_by: S.user, data: makeSnapshot() });
  }, "確定しました");
  render();
}

// ---- 確定版の表示・印刷
const PRANGE = {
  day:   { title: "日中 9:00〜18:00", segs: [[0, "09:00", "18:00"]] },
  night: { title: "夜勤 16:30〜翌9:30", segs: [[0, "16:30", "23:30"], [1, "00:00", "09:30"]] },
  all:   { title: "全日 0:00〜23:30", segs: [[0, "00:00", "23:30"]] },
};
function pageRows(shift) {
  const rows = [];
  for (const [off, a, b] of PRANGE[shift].segs)
    SLOTS.filter((s) => inRange(s, [a, b])).forEach((s, i) => rows.push({ s, off, next: off && i === 0, label: (off && i === 0 ? "翌" : "") + slotLabel(s) }));
  return rows;
}
function pubData() {
  const d = S.pub.data;
  return {
    cats: [...d.cats].sort((a, b) => a.sort - b.sort || a.id - b.id),
    item: new Map(d.items.map((i) => [i.id, i])),
    cat: new Map(d.cats.map((c) => [c.id, c])),
    residents: d.residents,
    entries: new Map(d.entries.map(([r, w, s, i]) => [ekey(r, w, s), i])),
    notes: d.notes || {},
  };
}
function checkList(el, list, keyName) {
  const prev = new Map($$("input", el).map((c) => [c.value, c.checked]));
  el.innerHTML = list.map(([v, label]) => `<label><input type="checkbox" value="${v}"${prev.has(String(v)) ? (prev.get(String(v)) ? " checked" : "") : " checked"}> ${esc(label)}</label>`).join("")
    + `<button type="button" class="ghost small" data-all="${keyName}">全部</button><button type="button" class="ghost small" data-none="${keyName}">外す</button>`;
}
// 画面の選択内容から、ページの中身（表示・Excel・PDF共通）を作る
function buildPages() {
  const D = pubData();
  const mode = $("input[name=p-mode]:checked").value, shift = $("input[name=p-shift]:checked").value;
  const paper = $("input[name=p-paper]:checked").value, color = $("#p-color").checked;
  const catSel = new Set($$("#p-cats input:checked").map((c) => +c.value));
  const cats = D.cats.filter((c) => catSel.has(c.id));
  const catLabel = catSel.size === D.cats.length ? "" : `【${cats.map((c) => c.name).join("・") || "区分なし"}】`;
  const land = mode === "day" && shift === "day";
  const rows = pageRows(shift);
  const cell = (rid, wd, s) => {
    const iid = D.entries.get(ekey(rid, wd, s)), it = iid && D.item.get(iid);
    if (!it || !catSel.has(it.category_id)) return { text: "" };
    const c = D.cat.get(it.category_id);
    return { text: it.name, color: color && c ? c.color : null };
  };
  const pages = [];
  if (mode === "day") {
    const res = D.residents;
    const head = [["部屋", ...res.map((r) => r.room)], ["名前", ...res.map((r) => r.name)]];
    for (const wd of $$("#p-days input:checked").map((c) => +c.value)) {
      const nw = (wd + 1) % 7;
      pages.push({
        sheet: `${WD[wd]}曜日`, title: `${WD[wd]}曜日　${PRANGE[shift].title}${catLabel}`, head,
        rows: rows.map((row) => ({ ...row, cells: res.map((r) => cell(r.id, (wd + row.off) % 7, row.s)) })),
        note: shift === "night" ? [D.notes[wd], D.notes[nw] ? `（翌${WD[nw]}）${D.notes[nw]}` : ""].filter(Boolean).join("　") : (D.notes[wd] || ""),
      });
    }
  } else {
    const head = [["", ...WD.map((w) => w + (shift === "night" ? "→翌" : ""))]];
    const sel = new Set($$("#p-people input:checked").map((c) => +c.value));
    for (const r of D.residents.filter((x) => sel.has(x.id)))
      pages.push({
        sheet: `${r.room} ${r.name}`, title: `${r.room}　${r.name} 様　${PRANGE[shift].title}${catLabel}`, head,
        rows: rows.map((row) => ({ ...row, cells: WD.map((_, wd) => cell(r.id, (wd + row.off) % 7, row.s)) })), note: "",
      });
  }
  return { pages, mode, shift, paper, land, cats: color ? cats : [], color,
    stamp: `${CFG.FACILITY_NAME || ""}　確定 ${fmtTime(S.pub.published_at)}`,
    fileBase: `ルート表_${mode === "day" ? "曜日別" : "利用者別"}_${PRANGE[shift].title.split(" ")[0]}${(catLabel ? "_" + catLabel.replace(/[【】]/g, "") : "")}_${fmtTime(S.pub.published_at).split(" ")[0].replace(/\//g, "")}` };
}

function renderKakutei() {
  const info = $("#kakutei-info");
  const btns = ["#btn-print", "#btn-xlsx", "#btn-pdf"];
  if (!S.pub) {
    info.innerHTML = `<b>まだ確定されていません。</b>「ルート編集」で内容を確認して「確定する」を押すと、ここに表示されます。`;
    $("#print-area").innerHTML = ""; btns.forEach((b) => ($(b).disabled = true)); return;
  }
  btns.forEach((b) => ($(b).disabled = false));
  const D = pubData(), p = pendingChanges();
  info.innerHTML = `確定版：<b>${fmtTime(S.pub.published_at)}</b> 確定（${esc(S.pub.published_by || "")}）` +
    ((p.entries || p.other.length) ? `　<span class="warn">※編集画面に未確定の変更があります（ここには反映されていません）</span>` : "");
  checkList($("#p-days"), WD.map((w, i) => [i, w]), "days");
  checkList($("#p-people"), D.residents.map((r) => [r.id, `${r.room} ${r.name}`]), "people");
  checkList($("#p-cats"), D.cats.map((c) => [c.id, c.name]), "cats");
  const mode = $("input[name=p-mode]:checked").value;
  $("#p-days-row").hidden = mode !== "day"; $("#p-people-row").hidden = mode !== "person";

  const B = buildPages();
  const [W, H] = B.paper === "A3" ? (B.land ? [420, 297] : [297, 420]) : (B.land ? [297, 210] : [210, 297]);
  const M = 8, k = B.paper === "A3" ? 1.414 : 1;
  $("#page-style").textContent = `@page { size: ${B.paper} ${B.land ? "landscape" : "portrait"}; margin: ${M}mm; }`;
  const td = (c) => `<td${c.color ? ` style="background:${esc(c.color)};color:${textColor(c.color)}"` : ""}>${esc(c.text)}</td>`;
  const html = B.pages.map((pg) => {
    const head = pg.head.map((r, i) => `<tr class="${pg.head.length === 2 && i === 0 ? "p-room" : "p-name"}">${r.map((v) => `<th>${esc(v)}</th>`).join("")}</tr>`).join("");
    const body = pg.rows.map((row) => `<tr class="${row.s.endsWith(":00") ? "hour" : "half"}${row.next ? " nextday" : ""}"><th>${row.label}</th>${row.cells.map(td).join("")}</tr>`).join("");
    return `<div class="sheet ${B.land ? "land" : "port"} ${B.mode === "day" ? "by-day" : "by-person"}${pg.rows.length > 40 ? " dense" : ""}" style="width:${W - 2 * M}mm;height:${H - 2 * M - 1}mm;--k:${k}">
      <div class="p-head"><div class="p-title">${esc(pg.title)}</div><div class="p-legend">${legendHTML(B.cats)}</div><div class="p-stamp">${esc(B.stamp)}</div></div>
      <div class="p-body"><table class="ptable"><colgroup><col class="pt-time">${pg.head[0].slice(1).map(() => "<col>").join("")}</colgroup><thead>${head}</thead><tbody>${body}</tbody></table></div>
      ${pg.note ? `<div class="p-note">メモ：${esc(pg.note)}</div>` : ""}</div>`;
  }).join("");
  $("#print-area").innerHTML = html || `<p class="hint">印刷する曜日・利用者を選んでください。</p>`;
  fitText();
}

// ---- ダウンロード（Excel・PDF）
const libs = {};
function needLib(name, src, check) {
  if (check()) return Promise.resolve();
  return (libs[name] ||= loadScript(src));
}
function saveBlob(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function downloadXlsx() {
  await needLib("exceljs", "lib/exceljs.min.js", () => window.ExcelJS);
  const B = buildPages();
  if (!B.pages.length) return toast("出力する曜日・利用者を選んでください", true);
  const wb = new ExcelJS.Workbook();
  const FONT = "游ゴシック", thin = { style: "thin", color: { argb: "FF999999" } }, med = { style: "medium", color: { argb: "FF333333" } };
  const argb = (hex) => "FF" + hex.replace("#", "").toUpperCase();
  const used = new Set();
  for (const pg of B.pages) {
    let name = pg.sheet.replace(/[\\/?*\[\]:]/g, "").slice(0, 31), n = 2;
    while (used.has(name)) name = pg.sheet.slice(0, 28) + "(" + n++ + ")";
    used.add(name);
    const ncol = pg.head[0].length;
    const ws = wb.addWorksheet(name, {
      pageSetup: { paperSize: B.paper === "A3" ? 8 : 9, orientation: B.land ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 1,
        horizontalCentered: true, margins: { left: 0.3, right: 0.3, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 } },
      views: [{ state: "frozen", ySplit: 1 + pg.head.length, xSplit: 1 }],
    });
    ws.getColumn(1).width = 8;
    for (let c = 2; c <= ncol; c++) ws.getColumn(c).width = B.mode === "day" && B.land ? 15 : 12;
    // タイトル行
    const t = ws.getRow(1);
    t.getCell(1).value = pg.title; t.getCell(1).font = { name: FONT, size: 14, bold: true };
    ws.mergeCells(1, 1, 1, Math.min(4, ncol));
    t.getCell(ncol).value = B.stamp; t.getCell(ncol).font = { name: FONT, size: 8, color: { argb: "FF555555" } };
    t.getCell(ncol).alignment = { horizontal: "right", vertical: "middle" };
    B.cats.forEach((c, i) => { const col = 5 + i; if (col >= ncol) return;
      const x = t.getCell(col); x.value = c.name; x.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(c.color) } };
      x.font = { name: FONT, size: 8 }; x.alignment = { horizontal: "center", vertical: "middle" }; x.border = { top: thin, left: thin, bottom: thin, right: thin }; });
    t.height = 24;
    // 見出し
    pg.head.forEach((hr, i) => {
      const r = ws.getRow(2 + i); r.height = i === pg.head.length - 1 ? 22 : 15;
      hr.forEach((v, j) => { const x = r.getCell(j + 1); x.value = v;
        x.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3B5B7A" } };
        x.font = { name: FONT, size: i === pg.head.length - 1 ? 12 : 9, bold: i === pg.head.length - 1, color: { argb: "FFFFFFFF" } };
        x.alignment = { horizontal: "center", vertical: "middle" };
        x.border = { top: thin, left: thin, right: thin, bottom: i === pg.head.length - 1 ? med : thin }; });
    });
    // 本体
    const r0 = 2 + pg.head.length;
    pg.rows.forEach((row, i) => {
      const r = ws.getRow(r0 + i), hour = row.s.endsWith(":00"), last = i === pg.rows.length - 1;
      r.height = pg.rows.length > 40 ? 15 : pg.rows.length > 25 ? 18 : 22;
      const top = row.next ? med : hour ? thin : { style: "hair", color: { argb: "FFBBBBBB" } };
      const tc = r.getCell(1); tc.value = row.label;
      tc.font = { name: FONT, size: hour ? 10 : 8, bold: hour, color: { argb: hour ? "FF000000" : "FF666666" } };
      tc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2F6" } };
      tc.alignment = { horizontal: "center", vertical: "middle" };
      tc.border = { top, left: thin, right: med, bottom: last ? med : undefined };
      row.cells.forEach((c, j) => { const x = r.getCell(j + 2); x.value = c.text || null;
        x.font = { name: FONT, size: 10 }; x.alignment = { horizontal: "center", vertical: "middle", shrinkToFit: true };
        if (c.color) x.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(c.color) } };
        x.border = { top, left: thin, right: thin, bottom: last ? med : undefined }; });
    });
    if (pg.note) { const r = ws.getRow(r0 + pg.rows.length + 1); r.getCell(1).value = "メモ：" + pg.note; r.getCell(1).font = { name: FONT, size: 10 }; }
    ws.pageSetup.printArea = `A1:${ws.getColumn(ncol).letter}${r0 + pg.rows.length + (pg.note ? 1 : 0)}`;
  }
  saveBlob(new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), B.fileBase + ".xlsx");
}
async function downloadPdf() {
  await needLib("jspdf", "lib/jspdf.umd.min.js", () => window.jspdf);
  await needLib("html2canvas", "lib/html2canvas.min.js", () => window.html2canvas);
  renderKakutei();
  const B = buildPages(), sheets = $$("#print-area .sheet");
  if (!sheets.length) return toast("出力する曜日・利用者を選んでください", true);
  const fmt = B.paper.toLowerCase(), ori = B.land ? "landscape" : "portrait";
  const pdf = new jspdf.jsPDF({ orientation: ori, unit: "mm", format: fmt });
  const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight(), M = 8;
  for (let i = 0; i < sheets.length; i++) {
    toast(`PDFを作成中… ${i + 1}/${sheets.length}`);
    const cv = await html2canvas(sheets[i], { scale: 2.5, backgroundColor: "#ffffff" });
    if (i) pdf.addPage(fmt, ori);
    const w = pw - 2 * M, h = Math.min(ph - 2 * M, w * cv.height / cv.width);
    pdf.addImage(cv.toDataURL("image/jpeg", 0.92), "JPEG", M, M, w, h);
  }
  pdf.save(B.fileBase + ".pdf");
  toast("PDFをダウンロードしました");
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
    renderKakuteiStatus();
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
    renderKakuteiStatus();
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

  // 確定
  $("#btn-kakutei").onclick = doKakutei;
  // 確定版の表示・印刷
  const po = $("#view-kakutei .print-opts");
  po.addEventListener("change", () => renderKakutei());
  po.addEventListener("click", (e) => {
    const b = e.target.closest("[data-all],[data-none]"); if (!b) return;
    $$("input", b.parentElement).forEach((c) => (c.checked = !!b.dataset.all)); renderKakutei();
  });
  $("#btn-print").onclick = () => { renderKakutei(); window.print(); };
  $("#btn-xlsx").onclick = () => guard(downloadXlsx);
  $("#btn-pdf").onclick = () => guard(downloadPdf);
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
    $("#demo-banner").hidden = false; $("#btn-logout").hidden = true; $("#user-label").textContent = S.user = "デモ";
    $("#btn-demo-reset").onclick = async () => { if (confirm("デモのデータを初期状態に戻しますか？")) { S.store.reset(); await start(); } };
    return start();
  }
  await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
  const client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  S.store = new SupaStore(client);
  const showLogin = () => { $$(".view").forEach((v) => (v.hidden = v.id !== "view-login")); $("#tabs").hidden = true; $(".user").hidden = true; };
  const enter = async (session) => {
    $("#tabs").hidden = false; $(".user").hidden = false;
    $("#user-label").textContent = S.user = session.user.email;
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
