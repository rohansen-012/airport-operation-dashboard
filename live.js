/* Live-data layer for the DEL dashboard.
   Needs serve.py (it fetches the feeds). When the page is opened without it
   (double-clicked file, GitHub Pages) the dashboard stays in simulation mode. */
"use strict";
(function () {
  const ARP = [28.5665, 77.1031];
  const ICAO2IATA = {IGO:"6E",AIC:"AI",AXB:"IX",AKJ:"QP",SEJ:"SG",LLR:"9I",UAE:"EK",QTR:"QR",ETD:"EY",DLH:"LH",BAW:"BA",VIR:"VS",SIA:"SQ",THA:"TG",AFR:"AF",KLM:"KL",THY:"TK",SWR:"LX",ACA:"AC",UAL:"UA",ALK:"UL",OMA:"WY",SVA:"SV",FDB:"FZ",ABY:"G9",RNA:"RA",BBC:"BG",KAL:"KE",CPA:"CX",ETH:"ET",MAS:"MH",FDX:"FX",BDA:"BZ",GFA:"GF",KAC:"KU",JAL:"JL",ANA:"NH",AAL:"AA",UZB:"HY",AUA:"OS",CES:"MU",CSN:"CZ",KZR:"KC",AFL:"SU",TGW:"TR",AIQ:"I5",RJA:"RJ",MEA:"ME",PIA:"PK",SAS:"SK",FIN:"AY",IBE:"IB",AZA:"AZ",UPS:"5X",GTI:"5Y",CLX:"CV",ABW:"RU",CKS:"K4",QFA:"QF",VTI:"UK",DRK:"KB",BTN:"B3"};
  const CARGO_AL = new Set(["FX","BZ","5X","5Y","CV","RU","K4"]);
  const catOf = (iata, cargo) => cargo || CARGO_AL.has(iata) ? "CGO" : ({"6E":"6E", AI:"AI", "9I":"AI", IX:"IX", QP:"QP", SG:"SG"}[iata] || (iata ? "INT" : "GA"));
  const NM = 1852;
  const toRad = d => d * Math.PI / 180;
  const distNm = (a, b) => { const R = 3440.065, dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

  const LV = window.LIVE = {
    on: false, avail: false, fidsKey: false, fidsMin: 240,
    ac: new Map(), sel: null, selF: null,
    fids: [], fidsAt: 0, fidsErr: null, metar: null, metarAt: 0,
    log: [], moves: [], adsbAt: 0, adsbErr: null, startedAt: Date.now(),
    map: null, markers: new Map(), trail: null, lastDraw: 0,
  };

  async function api(path){ const r = await fetch(path, {cache:"no-store"}); return r.json(); }
  function addLog(sev, text, t = Date.now()){ LV.log.unshift({sev, text, t}); LV.log.length = Math.min(LV.log.length, 60); if (LV.on) renderAlerts(); }

  /* ---------------- flight identity helpers ---------------- */
  function idOf(cs){
    const m = /^([A-Z]{3})(\w+)$/.exec(cs || "");
    if (!m) return {iata:"", num:cs || ""};
    const iata = ICAO2IATA[m[1]] || "";
    return {iata, num: iata ? `${iata} ${m[2]}` : cs};
  }
  const normNum = s => (s || "").replace(/\s+/g, "").toUpperCase();
  function matchFids(o){
    if (!o.cs) return null;
    const id = idOf(o.cs), n = normNum(id.num);
    let best = null;
    for (const f of LV.fids) {
      if ((f.cs && f.cs === o.cs) || normNum(f.number) === n) {
        if (!best || Math.abs((f.est || f.sched) - Date.now()) < Math.abs((best.est || best.sched) - Date.now())) best = f;
      }
    }
    return best;
  }
  function phaseOf(o){
    if (o.ground) return o.gs < 3 ? "On ground · stationary" : o.gs < 45 ? "Taxiing" : "Runway · take-off / landing roll";
    if (o.dist < 12 && o.alt < 5000 && o.vr < -250) return "Final approach";
    if (o.dist < 20 && o.alt < 10000 && o.vr > 250) return "Departing · climbing out";
    if (o.vr < -250) return "Descending";
    if (o.vr > 250) return "Climbing";
    return "En route in DEL airspace";
  }

  /* ---------------- polling ---------------- */
  async function pollAdsb(){
    if (!LV.on) return;
    let r; try { r = await api("/api/adsb"); } catch (e) { LV.adsbErr = "server not reachable"; return; }
    if (!r.data) { LV.adsbErr = r.error || "no data"; return; }
    LV.adsbErr = r.ok ? null : r.error;
    LV.src = r.data.sources || null; LV.osAccount = !!r.data.openskyAccount; LV.osSec = r.data.openskySeconds || 0;
    const seen = new Set(), now = Date.now();
    for (const a of r.data.ac || []) {
      if (a.lat == null || a.lon == null) continue;
      seen.add(a.hex);
      const prev = LV.ac.get(a.hex), o = prev || {hex:a.hex, trail:[]};
      const ground = a.alt_baro === "ground";
      Object.assign(o, {
        cs: (a.flight || "").trim().toUpperCase(), reg: a.r || "", type: a.t || "", desc: a.desc || "", ground,
        alt: ground ? 0 : Math.round(typeof a.alt_baro === "number" ? a.alt_baro : (a.alt_geom || 0)),
        gs: a.gs || 0, trk: a.track ?? a.true_heading ?? o.trk ?? 0, vr: a.baro_rate ?? a.geom_rate ?? 0,
        sq: a.squawk || "", lat: a.lat, lon: a.lon, posT: now - (a.seen_pos || 0) * 1000, seenT: now,
      });
      o.dist = distNm(ARP, [o.lat, o.lon]);
      const id = idOf(o.cs); o.label = id.num || o.reg || o.hex; o.iata = id.iata;
      const last = o.trail[o.trail.length - 1];
      if (!last || last[0] !== o.lat || last[1] !== o.lon) { o.trail.push([o.lat, o.lon]); if (o.trail.length > 60) o.trail.shift(); }
      // runway movement detection: ground <-> airborne transition close to the airport
      if (prev && prev.ground !== ground && o.dist < 5) {
        const f = matchFids(o), type = ground ? "L" : "T";
        LV.moves.unshift({t:now, type, label:o.label, trk:Math.round(o.trk), hex:o.hex});
        LV.moves.length = Math.min(LV.moves.length, 40);
        const route = f ? (type === "L" ? ` from ${f.city}` : ` to ${f.city}`) : "";
        addLog("info", `${o.label}${route} ${type === "L" ? "landed" : "took off"} · ${o.type || "aircraft"} · track ${pad3(o.trk)}° (ADS-B).`);
      }
      if (["7500", "7600", "7700"].includes(o.sq) && o.sqAlert !== o.sq) {
        o.sqAlert = o.sq;
        addLog("crit", `${o.label} squawking ${o.sq} (${{"7500":"unlawful interference","7600":"radio failure","7700":"general emergency"}[o.sq]}) · ${Math.round(o.dist)} nm from DEL, ${o.alt} ft.`);
      }
      LV.ac.set(a.hex, o);
    }
    for (const [hex, o] of LV.ac) if (!seen.has(hex) && now - o.seenT > 60000) {
      LV.ac.delete(hex);
      const m = LV.markers.get(hex); if (m) { m.remove(); LV.markers.delete(hex); }
      if (LV.sel === hex) LV.sel = null;
    }
    LV.adsbAt = now;
  }
  const pad3 = n => String(Math.round(n) % 360).padStart(3, "0");

  async function pollMetar(){
    if (!LV.on) return;
    try {
      const r = await api("/api/metar"); const m = r.data && r.data[0];
      if (m) {
        if (!LV.metar || LV.metar.rawOb !== m.rawOb) { if (LV.metar) addLog("info", `New METAR: ${m.rawOb}`); }
        LV.metar = m; LV.metarAt = Date.now();
      }
    } catch (e) {}
  }
  function normFids(d){
    const out = [], T = s => s && s.utc ? Date.parse(String(s.utc).replace(" ", "T")) : null;
    for (const [key, dir] of [["arrivals", "A"], ["departures", "D"]]) for (const x of (d && d[key]) || []) {
      const m = x.movement || (dir === "A" ? x.arrival : x.departure) || {};
      const other = x.movement ? x.movement.airport : (dir === "A" ? x.departure && x.departure.airport : x.arrival && x.arrival.airport) || {};
      const al = x.airline || {};
      out.push({
        dir, number: x.number || "", cs: (x.callSign || "").toUpperCase().trim(), airline: al.name || "", alIata: al.iata || "",
        city: other.shortName || other.municipalityName || other.name || "—", iata: other.iata || other.icao || "",
        sched: T(m.scheduledTime), est: T(m.runwayTime) || T(m.revisedTime) || T(m.predictedTime),
        terminal: (m.terminal || "").replace(/^T/i, ""), gate: m.gate || "", belt: m.baggageBelt || "", runway: m.runway || "",
        status: x.status || "Unknown", cargo: !!x.isCargo, model: (x.aircraft && x.aircraft.model) || "", reg: (x.aircraft && x.aircraft.reg) || "",
      });
    }
    return out.filter(f => f.sched);
  }
  async function pollFids(force){
    if (!LV.on || !LV.fidsKey) return;
    try {
      const r = await api("/api/fids" + (force ? "?force=1" : ""));
      LV.fidsErr = r.ok ? null : (r.error || "error");
      if (r.data && r.fetched !== LV.fidsAt) {
        const first = !LV.fidsAt;
        LV.fids = normFids(r.data); LV.fidsAt = r.fetched;
        if (!first || force) addLog("info", `Flight board refreshed from AeroDataBox (${LV.fids.length} flights).`);
      }
    } catch (e) { LV.fidsErr = "server not reachable"; }
  }

  /* ---------------- live map ---------------- */
  const PLANE_D = (() => {
    const top = [[6,0],[5,-.7],[3.8,-.95],[1.4,-.95],[-1,-6.2],[-2.2,-6.2],[-1,-.95],[-4.3,-.85],[-5.5,-2.9],[-6.3,-2.9],[-5.8,-.5],[-6.2,0]];
    const pts = top.concat(top.slice(1, -1).reverse().map(([x, y]) => [x, -y]));
    return "M" + pts.map(([x, y]) => `${(y * 1.7).toFixed(2)},${(-x * 1.7).toFixed(2)}`).join("L") + "Z"; // nose points north
  })();
  function ensureMap(){
    if (LV.map || typeof L === "undefined") return;
    const el = $("#lmap");
    LV.map = L.map(el, {zoomControl:true, attributionControl:true, worldCopyJump:false}).setView(ARP, 12);
    const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {maxZoom:18, attribution:"Imagery © Esri, Maxar, Earthstar Geographics"});
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19, attribution:"© OpenStreetMap contributors"});
    sat.addTo(LV.map);
    L.control.layers({"Satellite": sat, "Street map": osm}, null, {position:"topright"}).addTo(LV.map);
    LV.map.attributionControl.addAttribution("Aircraft: OpenSky Network, adsb.lol (ODbL)");
    for (const nm of [5, 10, 20, 40]) {
      L.circle(ARP, {radius:nm * NM, color:"#ffffff", weight:1, opacity:.35, fill:false, dashArray:"4 6", interactive:false}).addTo(LV.map);
      L.marker([ARP[0] + nm / 60, ARP[1]], {interactive:false, icon:L.divIcon({className:"ring-l", html:`${nm} nm`, iconSize:[40, 12], iconAnchor:[20, 6]})}).addTo(LV.map);
    }
    LV.map.on("click", () => { LV.sel = null; LV.selF = null; updateUI(); });
  }
  function colorFor(o){ const f = o._f; const cat = catOf(o.iata || (f && f.alIata), f && f.cargo); return cat === "GA" ? "#b8bcc2" : catCol[cat]; }
  function markerFor(o){
    let m = LV.markers.get(o.hex);
    if (!m) {
      m = L.marker([o.lat, o.lon], {icon:L.divIcon({className:"acm", iconSize:[30, 30], iconAnchor:[15, 15],
        html:`<svg viewBox="-12 -12 24 24" width="30" height="30"><path d="${PLANE_D}" stroke="#000" stroke-width=".7"/></svg><span class="acl"></span>`})});
      m.on("click", e => { L.DomEvent.stopPropagation(e); LV.sel = o.hex; LV.selF = null; updateUI(); });
      m.on("mouseover", e => { const a = LV.ac.get(o.hex); if (a) showTip(e.originalEvent, a.label, [["Type", a.type || "—"], ["Phase", phaseOf(a)], ["Altitude", a.ground ? "ground" : a.alt.toLocaleString() + " ft"], ["Speed", Math.round(a.gs) + " kt"], ["Distance", a.dist.toFixed(1) + " nm"]]); });
      m.on("mouseout", hideTip);
      m.addTo(LV.map); LV.markers.set(o.hex, m);
      if (!LV.fitted && LV.ac.size > 3) { LV.fitted = true; } // keep the airport-centred view
    }
    return m;
  }
  function drawLive(){
    if (!LV.map) return;
    const now = Date.now();
    for (const o of LV.ac.values()) {
      o._f = o._f === undefined || now - (o._fT || 0) > 30000 ? matchFids(o) : o._f; if (now - (o._fT || 0) > 30000) o._fT = now;
      let lat = o.lat, lon = o.lon;
      if (o.gs > 2) { // dead-reckon between position reports so the aircraft glide
        const dt = Math.min(o.ground ? 20 : 120, Math.max(0, (now - o.posT) / 1000)), d = o.gs * dt / 3600 / 60;
        lat += d * Math.cos(toRad(o.trk)); lon += d * Math.sin(toRad(o.trk)) / Math.cos(toRad(lat));
      }
      o.dlat = lat; o.dlon = lon;
      const m = markerFor(o); m.setLatLng([lat, lon]);
      const el = m.getElement(); if (!el) continue;
      const svg = el.firstChild, sel = LV.sel === o.hex;
      svg.style.transform = `rotate(${o.trk}deg) scale(${o.ground ? .72 : 1})`;
      svg.firstChild.setAttribute("fill", colorFor(o));
      svg.firstChild.setAttribute("stroke", sel ? "#fff" : "#000"); svg.firstChild.setAttribute("stroke-width", sel ? "1.6" : ".7");
      const showLbl = sel || (o.ground ? o.gs > 3 : o.dist < 25);
      const altTxt = o.ground ? Math.round(o.gs) + " kt" : o.alt < 10000 ? o.alt.toLocaleString() + " ft" : "FL" + String(Math.round(o.alt / 100)).padStart(3, "0");
      const lbl = showLbl ? `${esc(o.label)}<br><b>${altTxt}</b>` : "";
      if (el.lastChild.innerHTML !== lbl) el.lastChild.innerHTML = lbl;
      el.style.zIndex = sel ? 1000 : o.ground ? 100 : 500;
    }
    const s = LV.sel && LV.ac.get(LV.sel);
    if (s) {
      const pts = s.trail.concat([[s.dlat, s.dlon]]);
      if (!LV.trail) LV.trail = L.polyline(pts, {color:"#ffffff", weight:2, opacity:.8, interactive:false}).addTo(LV.map); else LV.trail.setLatLngs(pts);
    } else if (LV.trail) { LV.trail.remove(); LV.trail = null; }
  }
  function sizeLiveMap(){
    const el = $("#lmap"), w = $("#mapWrap").clientWidth;
    el.style.height = Math.max(380, Math.round(w * 0.6)) + "px";
    if (LV.map) LV.map.invalidateSize();
  }

  /* ---------------- UI overrides ---------------- */
  function tag(el, kind){
    if (!el) return;
    let t = el.querySelector(":scope > .tag");
    if (!kind) { if (t) t.remove(); return; }
    if (!t) { t = document.createElement("span"); el.insertBefore(t, el.firstChild); }
    t.className = "tag " + kind; t.textContent = kind === "live" ? "LIVE" : "SIM";
  }
  const h2Of = id => document.getElementById(id).closest(".card").querySelector("h2");
  const kLabel = id => document.getElementById(id).parentElement.querySelector(".k-label");
  function setLabel(id, text){ const l = kLabel(id); if (!l.dataset.orig) l.dataset.orig = l.textContent; let s = l.querySelector(".lt"); if (!s) { l.textContent = ""; s = document.createElement("span"); s.className = "lt"; l.appendChild(s); } s.textContent = text ?? l.dataset.orig; }
  function setTags(){
    const live = LV.on, fids = live && LV.fidsKey && LV.fids.length > 0;
    const map = {mapWrap:true, runways:true, alerts:true, detail:true, arrBoard:fids, depBoard:fids, chHourly:false, chPax:false, terminals:false, turns:false, systems:false};
    for (const [id, isLive] of Object.entries(map)) tag(h2Of(id), live ? (isLive ? "live" : "sim") : null);
    const k = {kPax:false, kMov:fids, kHr:fids, kOtp:fids, kSec:false, kGnd:true, kBag:false, kCgo:false, kWx:!!LV.metar};
    for (const [id, isLive] of Object.entries(k)) { if (!live) setLabel(id, null); tag(kLabel(id), live ? (isLive ? "live" : "sim") : null); }
  }
  function fidsPill(f, now){
    const late = f.est && f.est - f.sched > 15 * 60e3;
    switch (f.status) {
      case "Canceled": case "CanceledUncertain": return ["Cancelled", "crit", "✕"];
      case "Diverted": return ["Diverted", "crit", "!"];
      case "Arrived": return [f.belt ? `Arrived · belt ${f.belt}` : "Arrived", "", "✓"];
      case "Departed": return ["Departed", "", "↑"];
      case "Approaching": return ["On approach", "info", "✈"];
      case "EnRoute": return [late ? `En route · late` : "En route", late ? "warn" : "info", "✈"];
      case "Boarding": return ["Boarding", "info", "▶"];
      case "GateClosed": return ["Gate closed", "serious", "■"];
      case "CheckIn": return ["Check-in", "good", "✓"];
      case "Delayed": return [f.est ? `Delayed · ${fmtT(f.est)}` : "Delayed", "warn", "!"];
      case "Expected": return late ? [`Delayed · ${fmtT(f.est)}`, "warn", "!"] : ["On time", "good", "✓"];
      default: return ["Scheduled", "", "·"];
    }
  }
  const DONE = new Set(["Arrived", "Departed"]);
  function boards(now){
    const row = f => {
      const late = f.est && Math.abs(f.est - f.sched) > 5 * 60e3, cat = catOf(f.alIata, f.cargo);
      const stand = [f.terminal ? "T" + f.terminal : "", f.gate].filter(Boolean).join(" · ") || "—";
      const sel = LV.selF === f || (LV.sel && LV.ac.get(LV.sel) && matchFids(LV.ac.get(LV.sel)) === f);
      return `<tr data-fi="${LV.fids.indexOf(f)}" class="${sel ? "sel" : ""}"><td class="mono">${fmtT(f.sched)}${late ? `<span class="est">${fmtT(f.est)}</span>` : ""}</td><td><i class="chip" style="--c:${cat === "GA" ? "#b8bcc2" : `var(${CAT_VAR[cat]})`}"></i> <b>${esc(f.number)}</b></td><td title="${esc(f.city)}">${esc(f.city)} <span class="muted">${esc(f.iata)}</span></td><td class="mono">${esc(stand)}</td><td>${pill(fidsPill(f, now))}</td></tr>`;
    };
    const t = f => f.est || f.sched;
    const arr = LV.fids.filter(f => f.dir === "A" && (t(f) > now - 40 * 60e3 || !DONE.has(f.status))).sort((a, b) => a.sched - b.sched).slice(0, 10);
    const dep = LV.fids.filter(f => f.dir === "D" && (t(f) > now - 10 * 60e3 || !DONE.has(f.status) && t(f) > now - 3 * 3600e3)).sort((a, b) => a.sched - b.sched).slice(0, 10);
    $("#arrBoard").innerHTML = arr.map(row).join("") || `<tr><td colspan="5" class="muted">No arrivals in the board window.</td></tr>`;
    $("#depBoard").innerHTML = dep.map(row).join("") || `<tr><td colspan="5" class="muted">No departures in the board window.</td></tr>`;
    const age = Math.round((now - LV.fidsAt) / 60e3);
    $("#arrCount").textContent = $("#depCount").textContent = `AeroDataBox · updated ${age} min ago · auto every ${LV.fidsMin} min`;
  }
  function ui(){
    const now = Date.now();
    const air = [...LV.ac.values()];
    const near = air.filter(o => o.dist <= 40), onGnd = near.filter(o => o.ground && o.dist < 4), airborne = near.filter(o => !o.ground);
    // header badge
    const os = LV.src && LV.src.opensky, osAge = os && os.fetched ? Math.round((now - os.fetched) / 1000) : null;
    const badge = $("#simBadge"), stale = !LV.adsbAt || now - LV.adsbAt > 30000 || (os && !os.ok && !os.n);
    badge.classList.add("live"); badge.classList.toggle("stale", !!stale);
    badge.textContent = !LV.adsbAt ? (LV.adsbErr ? "LIVE · ADS-B unavailable" : "LIVE · connecting…")
      : `LIVE · OpenSky ${osAge != null ? osAge + " s ago" : "—"} · ${LV.ac.size} aircraft`;
    badge.title = LV.src ? `OpenSky: ${os.ok ? os.n + " aircraft" : "error " + (os.error || "")} (${LV.osAccount ? "account" : "anonymous"}, refresh every ${LV.osSec} s)\nadsb.lol: ${LV.src.adsblol.ok ? LV.src.adsblol.n + " aircraft" : "error"} (every 5 s)` : "";
    // runway flow from low, descending/climbing traffic
    let west = 0, east = 0;
    for (const o of airborne) if (o.dist < 14 && o.alt < 5000 && Math.abs(o.vr) > 200) { const t = (o.trk + 360) % 360; if (t > 230 && t < 330) west++; else if (t > 50 && t < 150) east++; }
    const flow = west + east === 0 ? "not enough low traffic" : west >= east ? "West flow (runways 27 / 28 / 29)" : "East flow (runways 09 / 10 / 11)";
    $("#mapNote").textContent = `${airborne.length} airborne · ${onGnd.length} on airport · ${flow}` +
      (LV.src && !LV.osAccount ? ` · refresh ${Math.round(LV.osSec / 60)} min` : "");
    $("#mapNote").title = LV.src && !LV.osAccount ? `Positions refresh every ${Math.round(LV.osSec / 60)} min. Add a free OpenSky account in config.json for about every 25 s.` : "";
    // KPIs
    const set = (id, v, sub) => { $("#" + id).innerHTML = v; $("#" + id + "s").textContent = sub; };
    setLabel("kGnd", "Aircraft on airport (ADS-B)");
    set("kGnd", `${onGnd.length}`, `${onGnd.filter(o => o.gs > 3).length} moving · ${airborne.length} airborne within 40 nm`);
    if (LV.metar) {
      const m = LV.metar, v = parseFloat(m.visib), vm = String(m.visib).includes("+") ? "10+ km" : isFinite(v) ? (v * 1609 >= 1000 ? (v * 1.609).toFixed(1) + " km" : Math.round(v * 1609) + " m") : "—";
      setLabel("kWx", "Weather · METAR VIDP");
      set("kWx", `${m.temp ?? "—"}° <small>${vm}</small>`, `${m.wxString ? m.wxString + " · " : ""}${m.wdir === "VRB" ? "VRB" : pad3(m.wdir || 0)}/${String(m.wspd ?? 0).padStart(2, "0")} kt · QNH ${m.altim ?? "—"} · ${fmtT(m.obsTime * 1000)}`);
    }
    if (LV.fidsKey && LV.fids.length) {
      const inWin = LV.fids.filter(f => !/Cancel/.test(f.status));
      const done = inWin.filter(f => DONE.has(f.status) || (f.est || f.sched) < now - 20 * 60e3 && f.status !== "Delayed");
      const lastHr = done.filter(f => (f.est || f.sched) > now - 3600e3 && (f.est || f.sched) <= now);
      const ot = done.filter(f => !f.est || f.est - f.sched <= 15 * 60e3);
      setLabel("kMov", "Movements · board window"); set("kMov", `${done.length} <small>/ ${inWin.length}</small>`, `done vs listed, ${fmtT(Math.min(...LV.fids.map(f => f.sched)))}–${fmtT(Math.max(...LV.fids.map(f => f.sched)))}`);
      setLabel("kHr", "Movements · last 60 min"); set("kHr", `${lastHr.length} <small>/ 96 cap</small>`, `${lastHr.filter(f => f.dir === "A").length} arrivals · ${lastHr.filter(f => f.dir === "D").length} departures`);
      $("#kHrM").style.width = Math.min(100, lastHr.length / 96 * 100) + "%";
      setLabel("kOtp", "On-time · board window"); set("kOtp", done.length ? Math.round(ot.length / done.length * 100) + "%" : "—", `${LV.fids.filter(f => /Cancel/.test(f.status)).length} cancelled · within 15 min`);
      boards(now);
    } else {
      const msg = !LV.fidsKey ? "Simulated · add an AeroDataBox key in config.json for the real board" : LV.fidsErr ? "Board feed error: " + LV.fidsErr : "Loading board…";
      $("#arrCount").textContent = $("#depCount").textContent = msg;
    }
    // runways panel -> live movement detection
    const L5 = LV.moves.slice(0, 6);
    const since = fmtT(LV.startedAt), nL = LV.moves.filter(m => m.type === "L").length, nT = LV.moves.length - nL;
    $("#runways").innerHTML = `<div class="row"><div class="grow"><div class="name">Runway direction in use</div><div class="sub">Estimated from aircraft on approach / climb-out</div></div><div class="val">${west + east ? (west >= east ? "West" : "East") : "—"}</div></div>
      <div class="row"><div class="grow"><div class="name">Detected since ${since}</div><div class="sub">Ground ↔ air transitions within 5 nm</div></div><div class="val mono">${nL} ↓ · ${nT} ↑</div></div>` +
      (L5.map(m => `<div class="row" data-hex="${m.hex}" style="cursor:pointer"><span class="t">${fmtT(m.t)}</span><div class="grow"><span class="name">${esc(m.label)}</span> <span class="muted">${m.type === "L" ? "landed" : "took off"} · track ${pad3(m.trk)}°</span></div>${pill(m.type === "L" ? ["Landed", "info", "↓"] : ["Departed", "", "↑"])}</div>`).join("") || `<div class="hint" style="padding-top:8px">Landings and take-offs appear here as ADS-B sees them.</div>`);
    setTags();
  }
  function detail(){
    const o = LV.sel && LV.ac.get(LV.sel), f = o ? matchFids(o) : LV.selF;
    if (!o && !f) { $("#detail").innerHTML = `<div class="hint">Click any aircraft on the live map, a recent movement, or a board row to follow it: position, altitude, speed, phase and route.</div>`; return; }
    const rows = [];
    if (f) rows.push(["Flight", `${esc(f.number)} · ${esc(f.airline)}`], [f.dir === "A" ? "From" : "To", `${esc(f.city)} (${esc(f.iata)})`],
      ["Scheduled", fmtT(f.sched) + (f.est ? ` · ${f.dir === "A" ? "arr" : "dep"} ${fmtT(f.est)}` : "")], ["Terminal / gate", [f.terminal && "T" + f.terminal, f.gate].filter(Boolean).join(" · ") || "—"]);
    if (o) rows.push(["Callsign", esc(o.cs || "—")], ["Aircraft", `${esc(o.type || f && f.model || "—")} · ${esc(o.reg || "—")}`], ["Phase", phaseOf(o)],
      ["Altitude", o.ground ? "on ground" : `${o.alt.toLocaleString()} ft · ${o.vr > 0 ? "+" : ""}${Math.round(o.vr)} ft/min`], ["Ground speed", `${Math.round(o.gs)} kt · track ${pad3(o.trk)}°`],
      ["Squawk", esc(o.sq || "—")], ["From DEL", `${o.dist.toFixed(1)} nm`], ["Position report", `${Math.round((Date.now() - o.posT) / 1000)} s old (map extrapolates)`]);
    else rows.push(["On map", "not currently seen by ADS-B"]);
    const head = o ? pill([phaseOf(o).split(" · ")[0], o.ground ? "" : "info", o.ground ? "■" : "✈"]) : pill(fidsPill(f, Date.now()));
    $("#detail").innerHTML = `<div class="fl-head"><b>${esc(o ? o.label : f.number)}</b>${head}</div><dl class="detail">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  }
  function renderLog(){
    const ico = {info:"i", warn:"!", crit:"✕"};
    $("#alerts").innerHTML = LV.log.slice(0, 40).map(a => `<div class="alert"><span class="sev ${a.sev}">${ico[a.sev]}</span><div class="grow"><div style="font-size:12px">${esc(a.text)}</div><div class="muted" style="font-size:11px">${fmtT(a.t)} IST</div></div></div>`).join("")
      || `<div class="hint">Live events appear here: landings and take-offs seen by ADS-B, emergency squawks, new weather reports and board updates.</div>`;
  }

  /* ---------------- mode switching ---------------- */
  let timers = [];
  function start(on){
    LV.on = on && LV.avail;
    $("#btnLive").classList.toggle("on", LV.on);
    $("#btnLive").textContent = LV.on ? "Live data: on" : "Live data: off";
    for (const id of ["#btnFog", "#btnClose", "#btnNow"]) $(id).disabled = LV.on;
    $("#speed").querySelectorAll("button").forEach(b => b.disabled = LV.on);
    $("#map").style.display = LV.on ? "none" : "block";
    $("#lmap").style.display = LV.on ? "block" : "none";
    $("#simBadge").classList.toggle("live", LV.on);
    const note = $("#mapLegend .muted");
    if (note) { if (!note.dataset.orig) note.dataset.orig = note.textContent; note.textContent = LV.on ? "Real aircraft positions from ADS-B, between reports the map extrapolates along each track · grey = private / unknown · smaller icons are on the ground · click an aircraft for its live path" : note.dataset.orig; }
    timers.forEach(clearInterval); timers = [];
    if (LV.on) {
      if (S.fog) setFog(false);
      S.t = Date.now(); S.speed = 1; $("#speed").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.s === "1"));
      sizeLiveMap(); ensureMap(); setTimeout(sizeLiveMap, 50);
      pollAdsb(); pollMetar(); pollFids(false);
      timers.push(setInterval(pollAdsb, 4000), setInterval(pollMetar, 5 * 60e3), setInterval(() => pollFids(false), 5 * 60e3));
      if (!LV.log.length) addLog("info", `Live mode started. Aircraft from ADS-B (OpenSky + adsb.lol), weather from VIDP METAR${LV.fidsKey ? ", flight board from AeroDataBox" : ""}.`);
    } else {
      $("#simBadge").textContent = "SIMULATED LIVE FEED"; $("#simBadge").classList.remove("stale");
      hideTip(); setTags();
    }
    updateUI(); renderAlerts(); drawCharts();
  }
  LV.frame = now => { if (now - LV.lastDraw > 90) { drawLive(); LV.lastDraw = now; } };
  LV.ui = ui; LV.detail = detail; LV.renderLog = renderLog; LV.resize = sizeLiveMap;
  LV.selectFromBoard = i => { const f = LV.fids[i]; if (!f) return; LV.selF = f; const o = [...LV.ac.values()].find(a => matchFids(a) === f); LV.sel = o ? o.hex : null; if (o && LV.map) LV.map.panTo([o.lat, o.lon]); updateUI(); };
  LV.selectHex = hex => { const o = LV.ac.get(hex); LV.sel = o ? hex : null; LV.selF = null; if (o && LV.map) LV.map.panTo([o.lat, o.lon]); updateUI(); };
  LV.refreshBoard = () => pollFids(true);
  LV.normFids = normFids;

  document.querySelectorAll(".k-label").forEach(l => { l.dataset.orig = l.textContent; });
  $("#btnLive").addEventListener("click", () => start(!LV.on));
  addEventListener("resize", () => { if (LV.on) sizeLiveMap(); });
  (async () => {
    try {
      const h = await api("/api/health");
      LV.avail = !!h.ok; LV.fidsKey = !!h.fids; LV.fidsMin = h.fidsRefreshMinutes || 240;
    } catch (e) { LV.avail = false; }
    $("#btnLive").disabled = !LV.avail;
    $("#btnLive").title = LV.avail ? "Switch between live data and the simulation" : "Live data needs the local server: run  python serve.py  and open http://localhost:8790";
    if (LV.avail) start(true);
  })();
})();
