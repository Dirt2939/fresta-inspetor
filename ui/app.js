// Fresta Inspetor — the window. Once a second it asks the program (src/) for
// what Windows saw and draws it. It keeps nothing and talks to nothing else:
// the page can't reach the internet (see the CSP in tauri.conf.json).

"use strict";

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let snap = null;
let list = null;
let page = "geral";
let drawn = "";
const ui = { open: new Set(), pick: null, preview: null, sure: null, busy: false, note: null };

// ── Words and numbers ─────────────────────────────────────────────────────

const num = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const plural = (n, one, many) => `${num.format(n)} ${n === 1 ? one : many}`;

function bytes(n) {
  if (n < 1024) return [num.format(n), "B"];
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return [num.format(v >= 100 ? Math.round(v) : v), units[i]];
}
const bytesText = (n) => bytes(n).join(" ");

function clock(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return today ? t : `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${t}`;
}

function ago(ms) {
  const s = Math.max(0, (snap.now - ms) / 1000);
  if (s < 45) return "agora";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return clock(ms);
}

function lasted(a, b) {
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${num.format(s / 3600)} h`;
}

const short = (s, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ── Icons ─────────────────────────────────────────────────────────────────

const ICON = {
  rede: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5s1.3-6.1 3.9-8.5z"/>',
  arquivos: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  programas: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17"/><path d="M8 13l2 1.8-2 1.8"/><path d="M12.5 16.6h3.5"/>',
  chaves: '<circle cx="8" cy="15" r="4"/><path d="M11 12.2L19.5 4"/><path d="M16 7.5l2.5 2.5"/><path d="M14 9.5l1.8 1.8"/>',
  camera: '<rect x="3" y="6.5" width="13" height="11" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>',
  microphone: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v2.5"/>',
  location: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  open: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>',
  livre: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 6.8-1.2"/>',
  lista: '<path d="M12 3.5l7 2.8v5.2c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9V6.3z"/><path d="M8.8 12.2l2.2 2.2 4.3-4.4"/>',
  tudo: '<path d="M7 18.5h9.5a4 4 0 0 0 .9-7.9 5.5 5.5 0 0 0-10.4-1.4A4.6 4.6 0 0 0 7 18.5z"/><path d="M4 4l16 16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8.2 12.3l2.5 2.5 5.1-5.3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.6v5.2"/><path d="M12 16.2v.2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const icon = (name, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24">${ICON[name]}</svg>`;
const CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

// ── From the snapshot to what is shown ────────────────────────────────────

const ORDER = { fora: 0, "?": 1, lista: 2, meu: 3, chamada: 4, local: 5 };
const RING = { lista: "ok", meu: "mine", fora: "off", chamada: "call", local: "local", "?": "wait" };

function why(service) {
  return list?.rede.find((s) => s.nome === service)?.motivo ?? "";
}

/** Connections grouped the way a person thinks about them: by service. */
function groups(net) {
  const out = new Map();
  for (const c of net) {
    let key;
    let title;
    let text;
    switch (c.verdict) {
      case "lista":
        key = `svc:${c.service}`;
        title = c.service;
        text = why(c.service);
        break;
      case "meu":
        key = `meu:${c.host ?? c.ip}`;
        title = c.host ?? c.ip;
        text = "Você marcou como seu.";
        break;
      case "fora":
        key = `fora:${c.host ?? c.ip}`;
        title = c.host ?? c.ip;
        text = c.host ? "Não está na lista: nada explica por que a Fresta fala com ele." : "Um endereço sem nome, fora da lista.";
        break;
      case "chamada":
        key = "call";
        title = "Chamada direta";
        text = "Numa chamada das Rooms, a voz vai direto para o PC de quem está nela. Esses endereços não têm nome.";
        break;
      case "local": {
        const pc = c.ip.startsWith("127.") || c.ip === "::1";
        key = pc ? "local:pc" : "local:lan";
        title = pc ? "Este PC" : "Rede local";
        text = pc ? "Conversas dentro do próprio PC, como o Ollama e o retorno do login do Spotify." : "Aparelhos da sua rede, como um Ollama em outro PC.";
        break;
      }
      default:
        key = "wait";
        title = "Identificando…";
        text = "O Inspetor ainda está buscando o nome destes endereços.";
    }
    let g = out.get(key);
    if (!g) {
      g = { key, title, text, verdict: c.verdict, rows: [], sent: 0, recv: 0, last: 0, open: false, hosts: new Set() };
      out.set(key, g);
    }
    g.rows.push(c);
    g.sent += c.sent;
    g.recv += c.recv;
    g.last = Math.max(g.last, c.last);
    g.open ||= c.open;
    g.hosts.add(c.host ?? c.ip);
  }
  return [...out.values()].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.sent + b.recv - (a.sent + a.recv) || a.title.localeCompare(b.title));
}

function facts() {
  const gs = groups(snap.net);
  const fresta = snap.members.find((m) => m.name.toLowerCase() === "fresta.exe");
  const off = gs.filter((g) => g.verdict === "fora");
  const remote = gs.filter((g) => g.verdict !== "local");
  const services = gs.filter((g) => g.verdict === "lista" || g.verdict === "meu");
  const files = snap.places.reduce((n, p) => n + p.files, 0) + snap.loose.length;
  const inside = snap.places.filter((p) => p.zone === "fresta").reduce((n, p) => n + p.files, 0);
  const launches = snap.launches.filter((l) => !NOISE.has(l.name.toLowerCase()));
  const strange = launches.filter((l) => l.kind === "fora");
  const sensorsNow = snap.sensors.filter((s) => s.uses.some((u) => u.now && (!u.shared || fresta)));
  const sent = snap.net.reduce((n, c) => n + c.sent, 0);
  const recv = snap.net.reduce((n, c) => n + c.recv, 0);
  return { gs, fresta, off, remote, services, files, inside, launches, strange, sensorsNow, sent, recv };
}

// The processes WebView2 starts by the dozen: shown in the tree, not one by one.
const NOISE = new Set(["msedgewebview2.exe", "conhost.exe"]);

// ── The radar ─────────────────────────────────────────────────────────────

const COLORS = { lista: "#3ddc84", meu: "#e8903f", fora: "#ff4f3f", chamada: "#5ac8fa", local: "#8b97a8", "?": "#ffab2e" };
const RINGS = { local: 0.26, lista: 0.56, meu: 0.56, fora: 0.84, chamada: 0.84, "?": 0.84 };

class Radar {
  constructor(canvas, big) {
    this.canvas = canvas;
    this.big = big;
    this.nodes = new Map();
    this.sparks = [];
    this.count = {};
    this.hover = null;
    this.t0 = performance.now();
    canvas.addEventListener("mousemove", (e) => this.move(e));
    canvas.addEventListener("mouseleave", () => this.leave());
    canvas.addEventListener("click", () => {
      if (!this.hover) return;
      ui.open.add(this.hover.key);
      go("rede");
    });
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  update(gs) {
    const seen = new Set();
    for (const g of gs) {
      seen.add(g.key);
      let n = this.nodes.get(g.key);
      const ring = g.verdict === "lista" || g.verdict === "meu" ? "lista" : g.verdict === "local" ? "local" : "fora";
      if (!n) {
        n = { key: g.key, band: ring, order: (this.count[ring] = (this.count[ring] ?? -1) + 1), angle: null, bytes: g.sent + g.recv, sent: g.sent, recv: g.recv, born: performance.now() };
        this.nodes.set(g.key, n);
      }
      const ds = g.sent - n.sent;
      const dr = g.recv - n.recv;
      if (ds > 0) this.spark(n, true, ds);
      if (dr > 0) this.spark(n, false, dr);
      Object.assign(n, { g, sent: g.sent, recv: g.recv, bytes: g.sent + g.recv, verdict: g.verdict, ring: RINGS[g.verdict], live: g.open || snap.now - g.last < 4000 });
    }
    for (const k of [...this.nodes.keys()]) if (!seen.has(k)) this.nodes.delete(k);
    // Each ring shares its circle evenly, in the order places first appeared.
    const bands = {};
    for (const n of this.nodes.values()) (bands[n.band] ??= []).push(n);
    const turn = { lista: -Math.PI / 2, fora: -Math.PI / 2 + 0.5, local: Math.PI / 2 };
    for (const [band, ns] of Object.entries(bands)) {
      ns.sort((a, b) => a.order - b.order);
      ns.forEach((n, i) => {
        n.target = turn[band] + (i / ns.length) * Math.PI * 2;
        if (n.angle === null) n.angle = n.target;
      });
    }
    const ranked = [...this.nodes.values()].sort((a, b) => b.bytes - a.bytes);
    ranked.forEach((n, i) => (n.rank = i));
  }

  spark(n, out, amount) {
    const k = Math.min(6, 1 + Math.floor(Math.log10(1 + amount / 512)));
    for (let i = 0; i < k; i++) this.sparks.push({ n, out, p: -i * 0.13, v: 0.55 + Math.random() * 0.35 });
  }

  size() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(r.width * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    return { w: r.width, h: r.height, dpr };
  }

  where(n, w, h) {
    const R = Math.min(w, h) / 2 - (this.big ? 34 : 26);
    return { x: w / 2 + Math.cos(n.angle) * R * n.ring, y: h / 2 + Math.sin(n.angle) * R * n.ring };
  }

  radius(n) {
    return Math.min(this.big ? 20 : 15, 4 + 2.6 * Math.log10(1 + n.bytes / 256));
  }

  move(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    for (const n of this.nodes.values()) {
      const p = this.where(n, r.width, r.height);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < this.radius(n) + 9 && (!best || d < best.d)) best = { n, d };
    }
    this.hover = best?.n.g ?? null;
    this.canvas.style.cursor = best ? "pointer" : "default";
    const tip = $("#tip");
    if (!best) return (tip.hidden = true);
    const g = best.n.g;
    tip.innerHTML = `<b>${esc(g.title)}</b><span>${esc(label(g.verdict))} · ↑ ${bytesText(g.sent)} · ↓ ${bytesText(g.recv)}<br>${g.open ? "Conexão aberta agora" : "Visto " + ago(g.last)}</span>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(innerWidth - 310, e.clientX + 16)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  }

  leave() {
    this.hover = null;
    $("#tip").hidden = true;
  }

  loop(now) {
    if (!this.canvas.isConnected || radar !== this) return;
    requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const { w, h, dpr } = this.size();
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - (this.big ? 34 : 26);
    const t = (now - this.t0) / 1000;

    for (const n of this.nodes.values()) {
      const d = Math.atan2(Math.sin(n.target - n.angle), Math.cos(n.target - n.angle));
      n.angle += d * 0.08;
    }

    // The three rings: this PC and the network, the list, outside it.
    for (const [k, alpha] of [[RINGS.local, 0.07], [RINGS.lista, 0.1], [RINGS.fora, 0.08]]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * k, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,236,214,${alpha})`;
      ctx.lineWidth = 1;
      ctx.setLineDash(k === RINGS.fora ? [2, 5] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Lines out to every place Fresta talks to.
    for (const n of this.nodes.values()) {
      const p = this.where(n, w, h);
      const grad = ctx.createLinearGradient(cx, cy, p.x, p.y);
      const c = COLORS[n.verdict];
      grad.addColorStop(0, "rgba(232,144,63,0.05)");
      grad.addColorStop(1, hexa(c, n.live ? 0.45 : 0.16));
      ctx.strokeStyle = grad;
      ctx.lineWidth = n.live ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    // Bytes moving: caramel going out, light coming in.
    this.sparks = this.sparks.filter((s) => {
      s.p += s.v * (1 / 60);
      if (s.p > 1) return false;
      if (s.p < 0 || !this.nodes.has(s.n.key)) return s.p < 0;
      const p = this.where(s.n, w, h);
      const k = s.out ? s.p : 1 - s.p;
      const x = cx + (p.x - cx) * k;
      const y = cy + (p.y - cy) * k;
      ctx.beginPath();
      ctx.arc(x, y, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = s.out ? "rgba(255,180,110,0.95)" : "rgba(246,242,236,0.85)";
      ctx.shadowColor = s.out ? "#e8903f" : "#ffffff";
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      return true;
    });

    // The places.
    for (const n of this.nodes.values()) {
      const p = this.where(n, w, h);
      const grow = Math.max(0, Math.min(1, (now - n.born) / 500));
      const r = this.radius(n) * (0.4 + 0.6 * easeOut(grow));
      const c = COLORS[n.verdict];
      if (n.verdict === "fora") {
        const pulse = (t * 0.8) % 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4 + pulse * 16, 0, Math.PI * 2);
        ctx.strokeStyle = hexa(c, 0.5 * (1 - pulse));
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.fillStyle = hexa(c, this.hover?.key === n.key ? 0.28 : 0.12);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      if (this.big || n.verdict === "fora" || n.rank < 6) {
        // The name sits on the outer side, away from the lines.
        const cos = Math.cos(n.angle);
        const sin = Math.sin(n.angle);
        ctx.font = `${n.verdict === "fora" ? 600 : 500} ${this.big ? 12 : 11}px Geist, sans-serif`;
        ctx.textAlign = cos > 0.3 ? "left" : cos < -0.3 ? "right" : "center";
        ctx.textBaseline = sin > 0.3 ? "top" : sin < -0.3 ? "bottom" : "middle";
        ctx.fillStyle = n.verdict === "fora" ? "#ff8a7e" : "rgba(246,242,236,0.78)";
        const label = short(n.g.title, this.big ? 24 : 18);
        const lw = ctx.measureText(label).width;
        let lx = p.x + cos * (r + 8);
        let ly = p.y + sin * (r + 8);
        const align = ctx.textAlign;
        // A name that would leave the card goes under its dot instead.
        if ((align === "right" && lx - lw < 6) || (align === "left" && lx + lw > w - 6)) {
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          lx = p.x;
          ly = p.y + r + 8;
        }
        if (ctx.textAlign === "center") lx = Math.min(Math.max(lx, lw / 2 + 6), w - lw / 2 - 6);
        ctx.fillText(label, lx, ly);
        ctx.textBaseline = "alphabetic";
      }
    }

    // Fresta, in the middle: the island.
    const on = !!snap?.members.some((m) => m.name.toLowerCase() === "fresta.exe");
    const iw = this.big ? 84 : 70;
    const ih = this.big ? 28 : 24;
    ctx.shadowColor = on ? "rgba(232,144,63,0.7)" : "rgba(0,0,0,0)";
    ctx.shadowBlur = on ? 24 + Math.sin(t * 1.6) * 6 : 0;
    roundRect(ctx, cx - iw / 2, cy - ih / 2, iw, ih, ih / 2);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = on ? "rgba(232,144,63,0.55)" : "rgba(255,236,214,0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + iw / 2 - ih / 2, cy, ih * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = on ? "#ffb46e" : "#4a433c";
    ctx.fill();
    ctx.font = `600 ${this.big ? 12 : 11}px Geist, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillStyle = on ? "rgba(246,242,236,0.9)" : "rgba(246,242,236,0.4)";
    ctx.fillText("Fresta", cx - iw / 2 + ih * 0.55, cy + 4);

    if (!this.nodes.size) {
      ctx.font = "500 12.5px Geist, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,236,214,0.4)";
      ctx.fillText(on ? "Nenhuma conexão desde que o Inspetor abriu" : "A Fresta está fechada", cx, cy + ih + 24);
    }
  }
}

const easeOut = (x) => 1 - Math.pow(1 - x, 3);

function hexa(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function label(v) {
  return { lista: "Na lista", meu: "Seu", fora: "Fora da lista", chamada: "Chamada", local: "Local", "?": "Identificando" }[v];
}

let radar = null;

function mountRadar(sel, big) {
  const canvas = $(sel);
  if (!canvas) return;
  if (radar?.canvas !== canvas || radar.big !== big) {
    const old = radar;
    radar = new Radar(canvas, big);
    if (old) {
      // Keep where every place sits, so nothing jumps between pages.
      radar.nodes = old.nodes;
      radar.count = old.count;
      radar.sparks = old.sparks;
    }
  }
  radar.update(facts().gs);
}

// ── Pages ─────────────────────────────────────────────────────────────────

const PAGES = {
  geral() {
    const f = facts();
    const since = clock(snap.started);
    let mood = "good";
    let word = "Tudo <em>na lista.</em>";
    if (f.off.length) {
      mood = "bad";
      word = `<em>${f.off.length}</em> ${f.off.length === 1 ? "destino" : "destinos"} fora da lista.`;
    } else if (f.strange.length) {
      mood = "bad";
      word = `<em>${f.strange.length}</em> ${f.strange.length === 1 ? "programa" : "programas"} para conferir.`;
    } else if (!f.fresta && !snap.net.length) {
      mood = "idle";
      word = "A Fresta está <em>fechada.</em>";
    }
    const parts = [];
    if (f.remote.length) parts.push(`falar com <b>${plural(f.services.length, "serviço", "serviços")}</b>${f.off.length ? ` e <b>${plural(f.off.length, "endereço", "endereços")} fora da lista</b>` : ""}`);
    if (f.files) parts.push(`mexer em <b>${plural(f.files, "arquivo", "arquivos")}</b>${snap.loose.length ? `, ${plural(snap.loose.length, "fora", "fora")} das pastas dela` : ", todos nas pastas dela ou do Windows"}`);
    if (f.launches.length) parts.push(`abrir <b>${plural(f.launches.length, "programa", "programas")}</b>`);
    const text = parts.length
      ? `Desde ${since}, o Windows viu a Fresta ${parts.join(", ").replace(/, ([^,]*)$/, " e $1")}.`
      : f.fresta
        ? `Desde ${since}, a Fresta está aberta e não fez nada que o Windows tenha visto. Use a Fresta: tudo aparece aqui na hora.`
        : `O Inspetor está vigiando desde ${since}. Abra a Fresta e tudo o que ela fizer aparece aqui na hora.`;
    const ok = f.gs.filter((g) => g.verdict === "lista").length;

    const sensorDots = snap.sensors
      .map((s) => {
        const used = s.uses.length;
        const now = s.uses.some((u) => u.now && (!u.shared || f.fresta));
        return `<span class="${now ? "now" : used ? "used" : ""}" title="${esc(SENSOR[s.kind].name)}">${icon(s.kind)}</span>`;
      })
      .join("");
    const zones = zoneCounts();

    return `
      <div class="hero">
        <div class="card verdict ${mood === "good" ? "" : mood}">
          <h1 class="verdict-word">${word}</h1>
          <p class="verdict-text">${text}</p>
          <div class="proofs">${proofs(f)}</div>
          <div class="verdict-foot">
            ${f.off.length ? `<button class="btn primary" data-go="rede">Ver o que está fora</button><button class="btn" data-go="trava">Travar a Fresta</button>` : ""}
            ${!f.off.length && f.strange.length ? `<button class="btn primary" data-go="programas">Ver os programas</button>` : ""}
            <span class="badge ${snap.lock.mode === "livre" ? "" : "mine"}">${icon(snap.lock.mode === "livre" ? "livre" : snap.lock.mode)} ${LOCK[snap.lock.mode].short}</span>
          </div>
        </div>
        <div class="card radar-card"><canvas id="radar"></canvas></div>
      </div>
      <div class="tiles">
        ${tile("rede", "Rede", f.remote.length, f.remote.length === 1 ? "destino" : "destinos", f.off.length ? `<b style="color:var(--off)">${f.off.length} fora da lista</b>` : `${ok} na lista · ↑ ${bytesText(f.sent)}`, split([[ok, "ok"], [f.gs.filter((g) => g.verdict === "meu").length, "caramel"], [f.gs.filter((g) => g.verdict === "chamada").length, "call"], [f.off.length, "off"]]))}
        ${tile("arquivos", "Arquivos", f.files, f.files === 1 ? "arquivo" : "arquivos", snap.loose.length ? `${snap.loose.length} fora das pastas dela` : "Só nas pastas dela e do Windows", split([[zones.fresta, "caramel"], [zones.sistema, "dim"], [zones.fora, "warn"]]))}
        ${tile("programas", "Programas", f.launches.length, f.launches.length === 1 ? "aberto" : "abertos", f.strange.length ? `<b style="color:var(--warn)">${f.strange.length} fora da lista</b>` : `${snap.members.length} processos dela agora`, split([[f.launches.filter((l) => l.kind === "parte").length, "caramel"], [f.launches.filter((l) => l.kind === "aberto").length, "dim"], [f.strange.length, "warn"]]))}
        ${tile("sensores", "Sensores", f.sensorsNow.length, "em uso agora", f.sensorsNow.length ? `<b style="color:var(--off)">${f.sensorsNow.map((s) => SENSOR[s.kind].name).join(", ")}</b>` : lastSensor(), `<div class="sensor-dots">${sensorDots}</div>`)}
        ${tile("chaves", "Chaves", snap.keys.length, snap.keys.length === 1 ? "guardada" : "guardadas", "No Gerenciador de Credenciais", `<div class="split">${snap.keys.map(() => '<i class="c-caramel" style="flex:1"></i>').join("") || '<i class="c-dim" style="flex:1"></i>'}</div>`)}
      </div>`;
  },

  rede() {
    const f = facts();
    const [up, upU] = bytes(f.sent);
    const [down, downU] = bytes(f.recv);
    const rows = f.gs.map(groupView).join("");
    return `
      ${head("Rede", "Cada conexão que a Fresta abriu desde que o Inspetor está aberto, vista pelo próprio Windows e comparada com a lista pública.")}
      <div class="net-top">
        <div class="card radar-card">
          <canvas id="radar"></canvas>
          <div class="legend radar-legend"><span><i class="c-ok"></i>Na lista</span><span><i class="c-caramel"></i>Seu</span><span><i class="c-call"></i>Chamada</span><span><i class="c-off"></i>Fora</span><span><i class="c-local"></i>Local</span></div>
        </div>
        <div class="net-side">
          <div class="card stats">
            <div class="stat"><div class="stat-label">Destinos</div><div class="stat-num">${f.remote.length}</div></div>
            <div class="stat"><div class="stat-label">Fora da lista</div><div class="stat-num" style="color:${f.off.length ? "var(--off)" : "var(--ok)"}">${f.off.length}</div></div>
            <div class="stat"><div class="stat-label">Enviado</div><div class="stat-num">${up}<small>${upU}</small></div></div>
            <div class="stat"><div class="stat-label">Recebido</div><div class="stat-num">${down}<small>${downU}</small></div></div>
          </div>
          <div class="card now-card">
            <div class="live-head"><h2>Agora</h2><span class="dot ${f.fresta ? "live" : ""}"></span></div>
            ${liveView(f.gs)}
            <p class="live-foot">O Windows mostra para onde vai e quanto, não o conteúdo: as conexões são criptografadas.</p>
          </div>
        </div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Para onde a Fresta foi</h2><p>${plural(snap.net.length, "conexão", "conexões")}</p></div>
        <div class="card groups">${rows || `<div class="empty"><strong>Nenhuma conexão ainda.</strong>Use a Fresta: cada conexão aparece aqui na hora.</div>`}</div>
      </div>
      ${mineView()}`;
  },

  arquivos() {
    const z = zoneCounts();
    const total = z.fresta + z.sistema + z.fora;
    const delOut = snap.loose.filter((l) => l.deleted).length;
    const fresta = snap.places.filter((p) => p.zone === "fresta").sort((a, b) => b.files - a.files);
    const sys = snap.places.filter((p) => p.zone === "sistema" && p.files);
    return `
      ${head("Arquivos", "Cada arquivo que a Fresta abriu, criou, alterou ou apagou, agrupado por onde ele fica.")}
      ${snap.etw ? `<div class="note"><b>Sem o rastreio do Windows, os arquivos não aparecem.</b> Abra o Inspetor como administrador.</div>` : ""}
      <div class="card zones">
        <div class="split big">${total ? `<i class="c-caramel" style="flex:${z.fresta}"></i><i class="c-dim" style="flex:${z.sistema}"></i><i class="c-warn" style="flex:${z.fora}"></i>` : ""}</div>
        <div class="zones-nums">
          <div class="zone-num"><b>${num.format(z.fresta)}</b><span><i class="c-caramel"></i>Nas pastas da Fresta</span></div>
          <div class="zone-num"><b>${num.format(z.sistema)}</b><span><i class="c-dim"></i>Do Windows</span></div>
          <div class="zone-num"><b>${num.format(z.fora)}</b><span><i class="c-warn"></i>Fora das pastas dela</span></div>
          <div class="zone-num"><b style="color:${delOut ? "var(--off)" : "var(--ok)"}">${delOut}</b><span>Apagados fora das pastas dela</span></div>
        </div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Fora das pastas da Fresta</h2><p>O que você arrasta para o Pudim, anexa numa mensagem ou abre pela Biblioteca aparece aqui.</p></div>
        <div class="card rows">${snap.loose.map(looseView).join("") || `<div class="empty"><strong>Nada fora das pastas dela.</strong>A Fresta só mexeu no que é dela e no que todo programa usa do Windows.</div>`}</div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Pastas da Fresta</h2><p>As pastas da lista pública.</p></div>
        <div class="card rows">${fresta.map((p) => placeView(p, false)).join("")}</div>
      </div>
      ${sys.length ? `<div class="section"><div class="section-head"><h2>Do Windows</h2><p>Bibliotecas, fontes e o motor da janela, que todo programa usa.</p></div><div class="card rows">${sys.map((p) => placeView(p, true)).join("")}</div></div>` : ""}`;
  },

  programas() {
    const f = facts();
    const roots = snap.members.filter((m) => ["fresta.exe", "fresta-hook.exe"].includes(m.name.toLowerCase()));
    const kids = new Map();
    for (const m of snap.members) {
      if (roots.includes(m)) continue;
      kids.set(m.name, (kids.get(m.name) ?? 0) + 1);
    }
    const noise = snap.launches.length - f.launches.length;
    const tree = roots.length
      ? roots
          .map(
            (r, i) => `
        <div class="tree-row" style="${i ? "margin-top:18px" : ""}">
          <div class="node root"><span class="dot live"></span><div><b>${esc(r.name)}</b><br><small>PID ${r.pid} · ${esc(short(r.path, 46))}</small></div></div>
          ${r.name.toLowerCase() === "fresta.exe" && kids.size ? `<div class="wire"></div><div class="kids">${[...kids].map(([name, n]) => `<div class="kid"><div class="node"><div><b>${esc(name)}</b>${n > 1 ? ` <small>× ${n}</small>` : ""}<br><small>${esc(list?.programas.find((p) => p.exe.toLowerCase() === name.toLowerCase())?.motivo ?? "")}</small></div></div></div>`).join("")}</div>` : ""}
        </div>`,
          )
          .join("")
      : `<div class="empty" style="padding:8px"><strong>A Fresta está fechada.</strong>Quando ela abrir, os processos dela aparecem aqui.</div>`;
    const events = [...f.launches].sort((a, b) => b.start - a.start).map(launchView).join("");
    return `
      ${head("Programas", "Os processos que formam a Fresta agora e cada programa que ela abriu. Os que são parte dela são vigiados como se fossem ela.")}
      <div class="card tree">${tree}</div>
      <div class="section">
        <div class="section-head"><h2>O que a Fresta abriu</h2><p>${noise ? `${plural(noise, "processo", "processos")} do motor da janela ${noise === 1 ? "fica" : "ficam"} na árvore acima.` : ""}</p></div>
        <div class="card timeline">${events || `<div class="empty"><strong>Nenhum programa aberto.</strong>Desde ${clock(snap.started)}, a Fresta não abriu nenhum programa.</div>`}</div>
      </div>`;
  },

  sensores() {
    const fresta = facts().fresta;
    return `
      ${head("Câmera, microfone e localização", "O registro que o próprio Windows guarda de quem usou cada um. É o mesmo de Configurações → Privacidade.")}
      <div class="sensors">${snap.sensors.map((s) => sensorView(s, fresta)).join("")}</div>
      <div class="note"><b>Por que aparece o WebView2?</b> Quem liga o microfone ou a câmera numa chamada é o componente do Windows que desenha a janela da Fresta. Ele é o mesmo de outros apps (Teams, o Outlook novo, os Widgets), e o Windows anota o uso no nome dele. Compare o horário com o que você fez na Fresta. Se ela estava fechada, não foi ela.</div>`;
  },

  chaves() {
    return `
      ${head("Chaves", "O que a Fresta guardou no Gerenciador de Credenciais do Windows. O Inspetor vê o nome, a data e o tamanho de cada uma, nunca o conteúdo.", `<button class="btn" data-open="credenciais">${icon("open")}Abrir no Windows</button>`)}
      ${snap.keys.length ? `<div class="keys">${snap.keys.map(keyView).join("")}</div>` : `<div class="card empty"><strong>Nenhuma chave guardada.</strong>Quando você conectar um serviço na Fresta, a chave aparece aqui.</div>`}
      <div class="note"><b>Apagar desconecta a Fresta daquele serviço.</b> Para voltar, é só entrar de novo pelas Configurações dela. Você também pode revogar o acesso direto no serviço (na sua conta Google, no Spotify, no GitHub), o que vale até para uma cópia que alguém tivesse.</div>`;
  },

  trava() {
    const mode = snap.lock.mode;
    const pick = ui.pick && ui.pick !== mode ? ui.pick : null;
    const cards = ["livre", "lista", "tudo"]
      .map(
        (m) => `
      <button class="card mode ${m === mode ? "on" : ""} ${m === pick ? "picked" : ""}" data-pick="${m}">
        <div class="mode-glyph">${icon(m)}</div>
        <div class="mode-name">${LOCK[m].name}</div>
        <div class="mode-text">${LOCK[m].text}</div>
        <div class="mode-state">${m === mode ? `<span class="badge ok"><span class="dot"></span>Ativa agora</span>` : `<span class="badge">Escolher</span>`}</div>
      </button>`,
      )
      .join("");
    const preview = pick
      ? `
      <div class="card confirm">
        <div class="confirm-head">
          <div><h2>${pick === "livre" ? "Tirar a trava" : `Ligar “${LOCK[pick].name}”`}</h2><p class="lead" style="font-size:13px;margin-top:4px">O Inspetor vai rodar estes comandos do Firewall do Windows, exatamente assim:</p></div>
          <div style="display:flex;gap:8px"><button class="btn ghost" data-cancel>Cancelar</button><button class="btn primary" data-apply ${ui.busy ? "disabled" : ""}>${ui.busy ? "Aplicando…" : "Aplicar"}</button></div>
        </div>
        <div class="commands">${(ui.preview ?? []).map((c) => `<div class="cmd mono">${esc(shorten(c))}</div>`).join("")}</div>
      </div>`
      : "";
    const rule =
      mode === "livre"
        ? `Nenhuma regra do Inspetor no Firewall do Windows.`
        : `<b>${esc(mode === "lista" ? "Fresta Inspetor (somente a lista)" : "Fresta Inspetor (sem internet)")}</b><div>Para ${esc(snap.lock.exe)}${mode === "lista" ? ` · ${plural(snap.lock.allowed, "endereço liberado", "endereços liberados")}` : ""}</div>`;
    return `
      ${head("Trava", "Uma regra no Firewall do Windows. É o Windows que bloqueia, não a Fresta que promete, e a regra continua valendo com o Inspetor fechado.")}
      <div class="modes">${cards}</div>
      ${preview}
      ${ui.note ? `<div class="note" style="${ui.note.bad ? "background:rgba(255,79,63,.08);border-color:rgba(255,79,63,.3)" : ""}">${esc(ui.note.text)}</div>` : ""}
      ${snap.lock.error ? `<div class="note" style="background:rgba(255,79,63,.08);border-color:rgba(255,79,63,.3)"><b>O Firewall recusou:</b> ${esc(snap.lock.error)}</div>` : ""}
      <div class="section">
        <div class="card rule"><div class="rule-text">${rule}</div><button class="btn" data-open="firewall">${icon("open")}Ver no Firewall do Windows</button></div>
      </div>
      <div class="note"><b>O que a trava não alcança.</b> A regra vale para o fresta.exe, onde ficam as integrações, as atualizações e os chats. A janela da Fresta é desenhada pelo WebView2, um componente que o Windows divide entre vários apps, e o Firewall não separa um app do outro dentro dele. Essa parte o Inspetor vigia e mostra em Rede, sem bloquear. ${mode === "lista" ? "Com o Inspetor fechado, a regra fica como está: se um serviço trocar de servidor, aquela parte da Fresta pode falhar até você abrir o Inspetor de novo." : ""}</div>`;
  },

  lista() {
    if (!list) return "";
    return `
      ${head("A lista pública", `${esc(list.sobre)} Versão de ${esc(list.versao.split("-").reverse().join("/"))}.`, `<button class="btn" data-open="lista">${icon("open")}Ver no GitHub</button>`)}
      <div class="section" style="margin-top:0">
        <div class="section-head"><h2>Rede</h2><p>${plural(list.rede.length, "serviço", "serviços")}</p></div>
        <div class="list-grid">${list.rede.map((s) => `<div class="card svc"><div class="svc-name">${esc(s.nome)}</div><div class="svc-why">${esc(s.motivo)}</div><div class="chips">${s.hosts.map((h) => `<span class="chip">${esc(h)}</span>`).join("")}</div></div>`).join("")}</div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Programas</h2><p>Os marcados como parte da Fresta são vigiados como se fossem ela.</p></div>
        <div class="card rows">${list.programas.map((p) => `<div class="row prog-row"><span class="mono">${esc(p.exe)}</span><span>${p.parte ? `<span class="badge mine">Parte dela</span>` : `<span class="badge">Abre para você</span>`}</span><span style="color:var(--dim)">${esc(p.motivo)}</span></div>`).join("")}</div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Pastas</h2></div>
        <div class="card rows">${list.pastas.map((p) => `<div class="row prog-row" style="grid-template-columns:320px minmax(0,1fr)"><span class="mono">${esc(p.pasta)}</span><span style="color:var(--dim)">${esc(p.motivo)}</span></div>`).join("")}</div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Chaves</h2><p>No Gerenciador de Credenciais, com o nome “nome.${esc(list.chaves.servico)}”.</p></div>
        <div class="card rows">${Object.entries(list.chaves.nomes).map(([k, v]) => `<div class="row prog-row" style="grid-template-columns:320px minmax(0,1fr)"><span class="mono">${esc(k)}</span><span style="color:var(--dim)">${esc(v)}</span></div>`).join("")}</div>
      </div>`;
  },
};

const LOCK = {
  livre: { name: "Livre", short: "Sem trava", text: "Nenhuma regra. A Fresta acessa o que precisar e o Inspetor só observa." },
  lista: { name: "Só a lista", short: "Travada na lista", text: "O Windows bloqueia o fresta.exe para qualquer endereço que não seja de um serviço da lista." },
  tudo: { name: "Sem internet", short: "Sem internet", text: "O Windows bloqueia o fresta.exe para tudo fora deste PC e da sua rede. Atualizações, letras, integrações e chats param." },
};

const SENSOR = {
  camera: { name: "Câmera", never: "Nunca usada" },
  microphone: { name: "Microfone", never: "Nunca usado" },
  location: { name: "Localização", never: "Nunca usada" },
};

function proofs(f) {
  const touched = snap.loose.filter((l) => l.written || l.deleted || l.renamed).length;
  const sensors = f.sensorsNow.map((s) => SENSOR[s.kind].name.toLowerCase());
  const items = [
    f.off.length ? [false, `Falou com ${plural(f.off.length, "endereço", "endereços")} fora da lista`] : [true, "Só falou com serviços da lista"],
    touched ? [false, `Alterou ${plural(touched, "arquivo seu", "arquivos seus")} fora das pastas dela`] : [true, "Não alterou nem apagou nada seu"],
    f.strange.length ? [false, `Abriu ${plural(f.strange.length, "programa", "programas")} fora da lista`] : [true, "Não abriu programas fora da lista"],
    sensors.length ? [false, `${sensors.join(" e ")} em uso agora`.replace(/^./, (c) => c.toUpperCase())] : [true, "Câmera e microfone desligados"],
  ];
  return items.map(([ok, text]) => `<div class="proof ${ok ? "" : "no"}">${icon(ok ? "check" : "alert")}<span>${esc(text)}</span></div>`).join("");
}

function head(title, lead, side = "") {
  return `<div class="head"><div><h1>${title}</h1><p class="lead">${lead}</p></div>${side}</div>`;
}

function tile(pageName, name, n, unit, sub, viz) {
  return `<button class="card tile" data-go="${pageName}">
    <div class="tile-top"><span>${name}</span>${icon(pageName === "sensores" ? "microphone" : pageName)}</div>
    <div class="tile-num">${num.format(n)}<small>${unit}</small></div>
    <div class="tile-sub">${sub}</div>
    <div class="tile-viz">${viz}</div>
  </button>`;
}

function lastSensor() {
  const all = snap.sensors.flatMap((s) => s.uses.map((u) => ({ ...u, kind: s.kind }))).sort((a, b) => b.start - a.start);
  return all.length ? `${SENSOR[all[0].kind].name} usado ${clock(all[0].start)}` : "Nenhum uso registrado";
}

function split(parts) {
  const shown = parts.filter(([n]) => n > 0);
  return `<div class="split">${shown.map(([n, c]) => `<i class="c-${c}" style="flex:${n}"></i>`).join("") || '<i class="c-dim" style="flex:1;opacity:.5"></i>'}</div>`;
}

function zoneCounts() {
  const fresta = snap.places.filter((p) => p.zone === "fresta").reduce((n, p) => n + p.files, 0);
  const sistema = snap.places.filter((p) => p.zone === "sistema").reduce((n, p) => n + p.files, 0);
  return { fresta, sistema, fora: snap.loose.length };
}

function groupView(g) {
  const open = ui.open.has(g.key);
  const total = g.sent + g.recv || 1;
  const hosts = [...g.hosts];
  const conns = open
    ? `<div class="conns">${g.rows
        .sort((a, b) => b.last - a.last)
        .map(
          (c) => `<div class="conn">
          <span class="host" title="${esc(c.host ?? "")}">${esc(c.host ?? "sem nome")}</span>
          <span class="mono">${esc(c.ip.includes(":") ? `[${c.ip}]` : c.ip)}:${c.port}</span>
          <span>${c.udp ? (c.port === 443 ? "QUIC" : "UDP") : "TCP"} · ${esc(c.proc)}</span>
          <span>↑ ${bytesText(c.sent)} · ↓ ${bytesText(c.recv)}</span>
          <span class="actions">${c.verdict === "fora" ? `<button class="btn ghost" data-mine="${esc(c.host ?? c.ip)}">É meu</button>` : c.open ? `<span class="badge ok">aberta</span>` : esc(ago(c.last))}</span>
        </div>`,
        )
        .join("")}
        ${g.verdict === "fora" ? `<div class="note" style="margin-top:12px">Se for um endereço que você mesmo configurou na Fresta (um n8n, um relay de chamadas, um Ollama em outro PC), marque como seu. Se não for, <b>a Trava</b> faz o Windows bloquear.</div>` : ""}
      </div>`
    : "";
  return `<div class="group ${open ? "open" : ""} ${g.verdict === "fora" ? "alert" : ""}">
    <button class="group-row" data-toggle="${esc(g.key)}">
      <span class="ring ${RING[g.verdict]} ${g.open ? "live" : ""}"><i></i></span>
      <span style="min-width:0"><div class="g-name">${esc(g.title)}</div><div class="g-why">${esc(g.text)}</div></span>
      <span class="g-hosts" title="${esc(hosts.join(", "))}">${esc(hosts.slice(0, 3).join(", "))}${hosts.length > 3 ? ` +${hosts.length - 3}` : ""}</span>
      <span class="bytes"><span>↑ ${bytesText(g.sent)} · ↓ ${bytesText(g.recv)}</span><span class="bytes-bar"><span class="up" style="width:${(g.sent / total) * 100}%"></span><span class="down" style="width:${(g.recv / total) * 100}%"></span></span></span>
      <span class="when">${g.open ? `<span class="badge ok">aberta</span>` : esc(ago(g.last))}</span>
      ${CHEV}
    </button>
    ${conns}
  </div>`;
}

function liveView(gs) {
  const now = gs
    .map((g) => ({ g, ...rateOf(g) }))
    .filter((x) => x.g.open || x.up + x.down > 0)
    .sort((a, b) => b.up + b.down - (a.up + a.down))
    .slice(0, 6);
  if (!now.length) return `<div class="live-empty">Nada aberto agora.</div>`;
  return `<div class="live-rows">${now
    .map(
      ({ g, up, down }) => `<button class="live-row" data-toggle-go="${esc(g.key)}">
      <span class="ring ${RING[g.verdict]} ${up + down > 0 ? "live" : ""}"><i></i></span>
      <span style="min-width:0"><div class="g-name">${esc(g.title)}</div><div class="g-why">${esc([...g.hosts][0])}</div></span>
      <span class="rate">${up + down > 0 ? `↓ ${bytesText(down)}/s<br><small>↑ ${bytesText(up)}/s</small>` : `<span class="badge ok">aberta</span>`}</span>
    </button>`,
    )
    .join("")}</div>`;
}

function mineView() {
  return `<div class="section">
    <div class="section-head"><h2>Meus endereços</h2><p>Ficam só neste PC, fora da lista pública.</p></div>
    <div class="card rows">
      ${snap.mine.map((m) => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto"><span class="mono">${esc(m)}</span><button class="btn ghost" data-unmine="${esc(m)}">${icon("x")}Tirar</button></div>`).join("") || `<div class="row" style="color:var(--dim)">Nenhum. Use para endereços que você mesmo configurou na Fresta, como um n8n ou um relay de chamadas.</div>`}
      <form class="mine-add" data-mine-form><input id="mine-input" placeholder="n8n.minhacasa.com.br ou 203.0.113.7" spellcheck="false" autocomplete="off"><button class="btn" type="submit">${icon("plus")}Adicionar</button></form>
    </div>
  </div>`;
}

function placeView(p, sys) {
  const name = p.path.split("\\").filter(Boolean).slice(-1)[0] ?? p.path;
  const counts = p.files
    ? [`<span class="badge">${plural(p.files, "arquivo", "arquivos")}</span>`, p.written ? `<span class="badge">${p.written} alterados</span>` : "", p.created ? `<span class="badge">${p.created} criados</span>` : "", p.deleted ? `<span class="badge">${p.deleted} apagados</span>` : ""].join("")
    : `<span class="badge" style="opacity:.6">Nada ainda</span>`;
  return `<div class="row place" style="${p.files ? "" : "opacity:.62"}">
    <span class="place-icon ${sys ? "sys" : ""}">${icon("arquivos")}</span>
    <span style="min-width:0"><div class="g-name">${esc(name)}<span style="color:var(--dim);font-weight:400"> · ${esc(p.motivo)}</span></div><div class="path"><bdi>${esc(p.path)}</bdi></div></span>
    <span class="counts">${counts}</span>
    <span style="display:flex;gap:8px;align-items:center"><span class="when" style="min-width:64px">${p.last ? esc(ago(p.last)) : ""}</span>${p.files && !sys ? `<button class="btn ghost" data-open="${esc(p.path)}">${icon("open")}</button>` : ""}</span>
  </div>`;
}

function looseView(l) {
  const marks = [l.opened ? `<span class="badge">abriu${l.opened > 1 ? ` ×${l.opened}` : ""}</span>` : "", l.created ? `<span class="badge">criou</span>` : "", l.written ? `<span class="badge warn">alterou</span>` : "", l.renamed ? `<span class="badge warn">renomeou</span>` : "", l.deleted ? `<span class="badge off">apagou</span>` : ""].join("");
  return `<div class="row loose">
    <span style="min-width:0"><div class="g-name">${esc(l.path.split("\\").slice(-1)[0])}</div><div class="path"><bdi>${esc(l.path)}</bdi></div></span>
    <span class="counts">${marks}</span>
    <span class="when">${esc(ago(l.last))}</span>
    <span style="color:var(--dim);font-size:12px">${esc(l.proc)}</span>
  </div>`;
}

const KIND = {
  parte: ["mine", "Parte da Fresta", "var(--caramel)"],
  aberto: ["", "Aberto para você", "var(--local)"],
  fora: ["warn", "Fora da lista", "var(--warn)"],
};

function launchView(l) {
  const [cls, text, color] = KIND[l.kind];
  const state = l.end ? `durou ${lasted(l.start, l.end)}` : `<span class="badge ok"><span class="dot"></span>rodando</span>`;
  return `<div class="event">
    <div class="event-time">${clock(l.start)}</div>
    <div class="event-mark"><i style="background:${color}"></i></div>
    <div style="min-width:0">
      <div class="event-title"><b>${esc(l.name)}</b><span class="badge ${cls}">${text}</span><span style="color:var(--dim);font-size:12.5px">${state} · aberto por ${esc(l.parent)}</span></div>
      <div class="event-why">${esc(l.motivo || (l.kind === "fora" ? "Este programa não está na lista. Se você abriu um arquivo pela Fresta agora, é o programa dele." : ""))}</div>
      ${l.cmd ? `<div class="cmd mono">${esc(l.cmd)}</div>` : l.path ? `<div class="cmd mono">${esc(l.path)}</div>` : ""}
    </div>
  </div>`;
}

function sensorView(s, fresta) {
  const own = s.uses.filter((u) => !u.shared);
  const now = s.uses.find((u) => u.now && (!u.shared || fresta));
  const last = s.uses[0];
  let state;
  let cls = "";
  if (now) {
    cls = "now";
    state = now.shared ? "Em uso agora, pelo motor da janela" : "Em uso agora pela Fresta";
  } else if (last) {
    state = `Último uso: ${clock((own[0] ?? last).start)}`;
  } else {
    cls = "never";
    state = SENSOR[s.kind].never;
  }
  const uses = s.uses
    .slice(0, 4)
    .map((u) => `<div class="use"><b>${u.shared ? "Motor da janela (WebView2)" : "Fresta"}</b><div>${u.now ? `desde ${clock(u.start)}, em uso` : `${clock(u.start)} → ${clock(u.stop)} · ${lasted(u.start, u.stop)}`}</div></div>`)
    .join("");
  return `<div class="card sensor ${cls}">
    <div class="sensor-icon">${icon(s.kind)}</div>
    <div class="sensor-name">${SENSOR[s.kind].name}</div>
    <div class="sensor-state">${state}</div>
    <div class="sensor-perm">${s.allowed ? `<span class="badge">Liberado no Windows para apps</span>` : `<span class="badge ok">Bloqueado no Windows</span>`}</div>
    ${uses ? `<div class="uses">${uses}</div>` : ""}
    <div class="sensor-foot"><button class="btn" data-open="${s.kind}">${icon("open")}Configurações do Windows</button></div>
  </div>`;
}

function keyView(k) {
  const sure = ui.sure === k.target;
  return `<div class="card key">
    <div class="key-glyph">${icon("chaves")}</div>
    <div class="key-label">${esc(k.label)}</div>
    <div class="key-target mono">${esc(k.target)}</div>
    <div class="key-meta">Salva ${esc(clock(k.written))} · ${plural(k.size, "byte", "bytes")}</div>
    <div class="key-foot">${k.old ? `<span class="badge warn">Do app antigo</span>` : "<span></span>"}<button class="btn danger ${sure ? "sure" : ""}" data-delkey="${esc(k.target)}">${sure ? "Apagar mesmo" : "Apagar"}</button></div>
  </div>`;
}

/** remoteip lists run to hundreds of ranges: the first few and a count. */
function shorten(cmd) {
  return cmd.replace(/remoteip=([^ ]+)/, (_, ips) => {
    const all = ips.split(",");
    return all.length > 4 ? `remoteip=${all.slice(0, 3).join(",")},… (mais ${all.length - 3} faixas)` : `remoteip=${ips}`;
  });
}

// ── Drawing ───────────────────────────────────────────────────────────────

function side() {
  const f = facts();
  $("#who").innerHTML = f.fresta
    ? `<div class="who-top"><span class="dot ${f.off.length ? "alert" : "live"}"></span>Fresta aberta</div><div class="who-sub">${plural(snap.members.length, "processo", "processos")} · vigiando desde ${clock(snap.started)}</div>`
    : `<div class="who-top"><span class="dot"></span>Fresta fechada</div><div class="who-sub">O Inspetor segue vigiando.</div>`;
  const badge = (k, text, cls = "") => {
    const b = $(`[data-k="${k}"]`);
    b.textContent = text;
    b.className = cls;
  };
  badge("rede", f.off.length || f.remote.length || "", f.off.length ? "off" : "");
  badge("arquivos", f.files ? num.format(f.files) : "");
  badge("programas", f.strange.length || f.launches.length || "", f.strange.length ? "warn" : "");
  badge("sensores", f.sensorsNow.length ? "agora" : "", "off");
  badge("chaves", snap.keys.length || "");
  badge("trava", snap.lock.mode === "livre" ? "" : "ligada", "on");
  for (const b of document.querySelectorAll(".nav button, .foot-link")) b.classList.toggle("on", b.dataset.page === page);
  const banner = $("#banner");
  banner.hidden = !snap.etw;
  if (snap.etw) banner.textContent = `O rastreio de eventos do Windows não iniciou (${snap.etw}). A rede vem só das conexões TCP abertas e os arquivos ficam de fora. Abra o Inspetor como administrador.`;
}

function draw() {
  if (!snap) return;
  side();
  const el = $("#page");
  // Typing in a field: leave the page alone until it is done.
  if (el.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  const html = PAGES[page]();
  if (html !== drawn) {
    const scroll = $("#main").scrollTop;
    // The radar keeps its canvas between redraws, so it never blinks.
    const canvas = $("#radar");
    el.innerHTML = html;
    drawn = html;
    const fresh = $("#radar");
    if (canvas && fresh && radar?.canvas === canvas && radar.big === (page === "rede")) fresh.replaceWith(canvas);
    $("#main").scrollTop = scroll;
  }
  if (page === "geral") mountRadar("#radar", false);
  if (page === "rede") mountRadar("#radar", true);
}

function go(name) {
  if (name === page) return;
  page = name;
  ui.pick = null;
  ui.note = null;
  drawn = "";
  const el = $("#page");
  el.classList.remove("enter");
  void el.offsetWidth;
  el.classList.add("enter");
  $("#main").scrollTop = 0;
  draw();
}

// ── Actions ───────────────────────────────────────────────────────────────

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.page) return go(d.page);
  if (d.go) return go(d.go);
  if (d.open) return invoke("open", { what: d.open });
  if (d.toggleGo) {
    ui.open.add(d.toggleGo);
    draw();
    return document.querySelector(`[data-toggle="${CSS.escape(d.toggleGo)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (d.toggle) {
    ui.open.has(d.toggle) ? ui.open.delete(d.toggle) : ui.open.add(d.toggle);
    return draw();
  }
  if (d.mine) return saveMine([...snap.mine, d.mine]);
  if (d.unmine) return saveMine(snap.mine.filter((m) => m !== d.unmine));
  if (d.delkey) {
    if (ui.sure !== d.delkey) {
      ui.sure = d.delkey;
      setTimeout(() => {
        if (ui.sure === d.delkey) (ui.sure = null), draw();
      }, 4000);
      return draw();
    }
    ui.sure = null;
    try {
      await invoke("key_delete", { target: d.delkey });
    } catch (err) {
      alert(err);
    }
    return refresh();
  }
  if (d.pick) {
    ui.note = null;
    if (d.pick === snap.lock.mode) {
      ui.pick = null;
      return draw();
    }
    ui.pick = d.pick;
    ui.preview = await invoke("lock_preview", { mode: d.pick });
    return draw();
  }
  if ("cancel" in d) {
    ui.pick = null;
    return draw();
  }
  if ("apply" in d && ui.pick) {
    ui.busy = true;
    draw();
    try {
      await invoke("lock_set", { mode: ui.pick });
      ui.note = { text: ui.pick === "livre" ? "Trava tirada: a regra saiu do Firewall do Windows." : `“${LOCK[ui.pick].name}” ligada no Firewall do Windows.` };
    } catch (err) {
      ui.note = { text: String(err), bad: true };
    }
    ui.busy = false;
    ui.pick = null;
    return refresh();
  }
});

document.addEventListener("submit", (e) => {
  if (!e.target.matches("[data-mine-form]")) return;
  e.preventDefault();
  const v = $("#mine-input").value.trim();
  if (!v) return;
  document.activeElement.blur();
  saveMine([...snap.mine, v]);
});

async function saveMine(hosts) {
  try {
    await invoke("mine_set", { hosts });
  } catch (err) {
    alert(err);
  }
  refresh();
}

const connKey = (c) => `${c.proc}|${c.ip}|${c.port}|${c.udp}`;
let rates = new Map();

/** Bytes per second of a group, from the last two snapshots. */
function rateOf(g) {
  let up = 0;
  let down = 0;
  for (const c of g.rows) {
    const r = rates.get(connKey(c));
    if (r) (up += r.up), (down += r.down);
  }
  return { up, down };
}

async function refresh() {
  const before = snap;
  try {
    snap = await invoke("snapshot");
  } catch (err) {
    console.error(err);
    return;
  }
  if (before) {
    const prev = new Map(before.net.map((c) => [connKey(c), c]));
    const dt = Math.max(0.5, (snap.now - before.now) / 1000);
    rates = new Map(
      snap.net.map((c) => {
        const p = prev.get(connKey(c));
        return [connKey(c), p ? { up: Math.max(0, c.sent - p.sent) / dt, down: Math.max(0, c.recv - p.recv) / dt } : { up: 0, down: 0 }];
      }),
    );
  }
  draw();
}

async function start() {
  if (!window.__TAURI__) {
    $("#page").innerHTML = head("Fresta Inspetor", "Esta página só funciona dentro do programa do Inspetor.");
    return;
  }
  list = await invoke("list");
  await refresh();
  setInterval(refresh, 1000);
}

start();
