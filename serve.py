#!/usr/bin/env python3
"""Local server for the DEL operations dashboard.

Serves the dashboard and fetches the live feeds on its behalf, because the
data providers do not allow a web page to call them directly (no CORS):

  /api/adsb   live aircraft within 40 nm of DEL      (adsb.lol, free, no key)
  /api/metar  latest VIDP weather report             (aviationweather.gov, free)
  /api/fids   DEL arrivals & departures board        (AeroDataBox via RapidAPI, needs a key)

Run:  python serve.py            then open http://localhost:8790
Key:  put it in config.json (see config.example.json) or set AERODATABOX_KEY.
Uses only the Python standard library.
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import urllib.parse
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
ARP = (28.5665, 77.1031)  # DEL airport reference point
RADIUS_NM = 40
UA = "del-ops-dashboard/1.0"


def load_config():
    cfg = {}
    path = os.path.join(ROOT, "config.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    key = (os.environ.get("AERODATABOX_KEY") or cfg.get("aerodatabox_key") or "").strip()
    if key.startswith("PASTE"):
        key = ""
    os_id = (os.environ.get("OPENSKY_CLIENT_ID") or cfg.get("opensky_client_id") or "").strip()
    os_secret = (os.environ.get("OPENSKY_CLIENT_SECRET") or cfg.get("opensky_client_secret") or "").strip()
    if os_id.startswith("PASTE"):
        os_id = os_secret = ""
    # OpenSky daily credits: ~400 anonymous, ~4000 with a free account -> spread over 24 h
    default_iv = 25 if (os_id and os_secret) else 240
    return {
        "key": key,
        # free plan = 400 units/month = ~200 board calls, so refresh rarely by default
        "fids_minutes": max(5, int(cfg.get("fids_refresh_minutes", 240))),
        "os_id": os_id, "os_secret": os_secret,
        "os_seconds": max(10, int(cfg.get("opensky_interval_seconds", default_iv))),
    }


CFG = load_config()
FIDS_CACHE_FILE = os.path.join(ROOT, "fids_cache.json")


def fetch_json(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        return json.loads(body) if body else None


class Feed:
    """Caches one upstream feed; on failure keeps serving the last good copy."""

    def __init__(self, name, ttl, fn):
        self.name, self.ttl, self.fn = name, ttl, fn
        self.lock = threading.Lock()
        self.data, self.fetched, self.error = None, 0.0, None

    def get(self, force=False, min_force_gap=0):
        with self.lock:
            age = time.time() - self.fetched
            stale = age >= self.ttl or (force and age >= min_force_gap)
            if stale or self.data is None:
                try:
                    self.data, self.fetched, self.error = self.fn(), time.time(), None
                    self.on_success()
                except Exception as exc:  # keep last good data
                    self.error = f"{type(exc).__name__}: {exc}"
                    if self.data is None:  # retry soon, but don't hammer a rate-limited API
                        self.fetched = time.time() - self.ttl + max(10, min(self.ttl / 2, 60))
            return {"ok": self.error is None, "error": self.error, "fetched": self.fetched * 1000, "data": self.data}

    def on_success(self):
        pass


def get_adsblol():
    lat, lon = ARP
    return fetch_json(f"https://api.adsb.lol/v2/point/{lat}/{lon}/{RADIUS_NM}")


_token = {"value": None, "exp": 0}


def opensky_token():
    if not (CFG["os_id"] and CFG["os_secret"]):
        return None
    if _token["value"] and time.time() < _token["exp"] - 60:
        return _token["value"]
    body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": CFG["os_id"],
                                   "client_secret": CFG["os_secret"]}).encode()
    req = urllib.request.Request(
        "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
        data=body, headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        tok = json.loads(resp.read())
    _token["value"], _token["exp"] = tok["access_token"], time.time() + int(tok.get("expires_in", 1800))
    return _token["value"]


def get_opensky():
    lat, lon = ARP
    d = RADIUS_NM / 60
    url = (f"https://opensky-network.org/api/states/all?lamin={lat - d:.3f}&lomin={lon - d * 1.14:.3f}"
           f"&lamax={lat + d:.3f}&lomax={lon + d * 1.14:.3f}")
    tok = opensky_token()
    data = fetch_json(url, {"Authorization": f"Bearer {tok}"} if tok else None)
    now = time.time()
    out = []
    for s in (data or {}).get("states") or []:
        if s[5] is None or s[6] is None:
            continue
        out.append({
            "hex": s[0], "flight": (s[1] or "").strip(), "lat": s[6], "lon": s[5],
            "alt_baro": "ground" if s[8] else (round(s[7] * 3.28084) if s[7] is not None else
                                               round((s[13] or 0) * 3.28084)),
            "gs": (s[9] or 0) * 1.94384, "track": s[10], "baro_rate": (s[11] or 0) * 196.85,
            "squawk": s[14] or "", "seen_pos": max(0, now - (s[3] or s[4] or now)), "src": "opensky",
        })
    return {"ac": out, "fetched_at": now}


def get_adsb():
    """Merge OpenSky (best coverage over India, rate-limited) with adsb.lol (fast, sparse)."""
    sources, merged = {}, {}
    for name, feed in (("opensky", FEEDS["opensky"]), ("adsblol", FEEDS["adsblol"])):
        r = feed.get()
        sources[name] = {"ok": r["ok"], "error": r["error"], "fetched": r["fetched"],
                         "n": len((r["data"] or {}).get("ac") or [])}
        age = time.time() - r["fetched"] / 1000
        for a in (r["data"] or {}).get("ac") or []:
            if a.get("lat") is None:
                continue
            a = dict(a, seen_pos=(a.get("seen_pos") or 0) + age)
            cur = merged.get(a["hex"])
            if cur is None or a["seen_pos"] < cur["seen_pos"]:
                if cur:  # keep registration / type that only adsb.lol knows
                    for k in ("r", "t", "desc"):
                        a.setdefault(k, cur.get(k))
                merged[a["hex"]] = a
            else:
                for k in ("r", "t", "desc"):
                    if a.get(k) and not cur.get(k):
                        cur[k] = a[k]
    return {"ac": list(merged.values()), "sources": sources,
            "openskyAccount": bool(CFG["os_id"] and CFG["os_secret"]), "openskySeconds": CFG["os_seconds"]}


def get_metar():
    return fetch_json("https://aviationweather.gov/api/data/metar?ids=VIDP&format=json&hours=2")


def get_fids():
    if not CFG["key"]:
        raise RuntimeError("No AeroDataBox key - add it to config.json")
    url = ("https://aerodatabox.p.rapidapi.com/flights/airports/iata/DEL"
           "?offsetMinutes=-120&durationMinutes=720&withLeg=false&direction=Both"
           "&withCancelled=true&withCodeshared=false&withCargo=true&withPrivate=false&withLocation=false")
    data = fetch_json(url, {"X-RapidAPI-Key": CFG["key"], "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com"})
    return data or {"arrivals": [], "departures": []}


class FidsFeed(Feed):
    """Board feed: persisted to disk so restarting the server doesn't spend API quota."""

    def __init__(self):
        super().__init__("fids", CFG["fids_minutes"] * 60, get_fids)
        if os.path.exists(FIDS_CACHE_FILE):
            try:
                with open(FIDS_CACHE_FILE, encoding="utf-8") as fh:
                    saved = json.load(fh)
                self.data, self.fetched = saved["data"], saved["fetched"]
            except Exception:
                pass

    def on_success(self):
        with open(FIDS_CACHE_FILE, "w", encoding="utf-8") as fh:
            json.dump({"fetched": self.fetched, "data": self.data}, fh)


FEEDS = {
    "opensky": Feed("opensky", CFG["os_seconds"], get_opensky),
    "adsblol": Feed("adsblol", 5, get_adsblol),
    "adsb": Feed("adsb", 3, get_adsb),
    "metar": Feed("metar", 300, get_metar),
    "fids": FidsFeed(),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/health":
            return self.send_json({"ok": True, "fids": bool(CFG["key"]), "fidsRefreshMinutes": CFG["fids_minutes"]})
        if url.path.startswith("/api/"):
            name = url.path[5:]
            feed = FEEDS.get(name)
            if not feed:
                return self.send_json({"ok": False, "error": "unknown feed"}, 404)
            if name == "fids" and not CFG["key"]:
                return self.send_json({"ok": False, "error": "no key", "data": None})
            force = parse_qs(url.query).get("force") == ["1"]
            return self.send_json(feed.get(force=force, min_force_gap=600))
        return super().do_GET()

    def log_message(self, fmt, *args):
        if "/api/" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"DEL dashboard: http://localhost:{PORT}")
    print("Aircraft: OpenSky", "with account" if CFG["os_id"] else "anonymous",
          f"every {CFG['os_seconds']} s + adsb.lol every 5 s")
    print("Live boards:", "on" if CFG["key"] else "off (no AeroDataBox key in config.json)",
          f"- refresh every {CFG['fids_minutes']} min" if CFG["key"] else "")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
