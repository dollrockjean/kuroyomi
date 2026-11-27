"""Re-run the reader-top checks against the LIVE site on a simulated iPhone 16 Pro Max.

The live server is Rocco's own, so this writes nothing to it: the book is a fixture, captured
once from a throwaway local server and then replayed into the live page with request routing.
Everything under test - index.html, brutalist.css, reader.js, app.js - is what Render serves.

  python tools/live_phone_check.py [--base URL] [--themes a,b]

Writes shots to tools/shots/v17-live/ and prints the measurements as JSON.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "tools"))
sys.path.insert(0, REPO)

from phone_shots import (  # noqa: E402
    DPR, MEASURE_JS, PORTRAIT, SHOT_ROOT, UA, book_payload, free_port, inset_css, start_server,
)
from screen_audit import AUDIT_JS, strip_is_flat  # noqa: E402

LIVE = "https://byob-webnovel-reader.onrender.com"
FIXTURE_USER = "V17LAYOUTFIXTURE"


def capture_fixture():
    """Boot a throwaway local server, plant the fixture book, record the three API answers."""
    db_path = os.path.join(SHOT_ROOT, "v17-fixture.db")
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(db_path + suffix):
            os.remove(db_path + suffix)
    os.environ["READER_DB_PATH"] = db_path
    import database  # noqa: PLC0415 - needs READER_DB_PATH first
    database.init_db()
    uid = database.get_or_create_user(FIXTURE_USER, "V17 Fixture")
    database.import_backup_data(book_payload(uid), uid)

    port = free_port()
    proc = start_server(db_path, port)
    base = "http://127.0.0.1:%d" % port
    try:
        def get(path):
            with urllib.request.urlopen(base + path, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))

        novels = get("/api/novels?user_id=%s" % uid)
        nid = novels["novels"][0]["id"]
        novel = get("/api/novels/%s?user_id=%s" % (nid, uid))
        chapters = {c["id"]: get("/api/chapters/%s" % c["id"]) for c in novel["chapters"]}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    return {"novels": novels, "novel": novel, "novel_id": nid, "chapters": chapters}


def install_routes(page, fx):
    def handle(route):
        url = route.request.url
        path = url.split("?", 1)[0]
        tail = path.rsplit("/", 1)[-1]
        if "/api/chapters/" in path:
            body = fx["chapters"].get(tail)
        elif path.endswith("/api/novels"):
            body = fx["novels"]
        elif "/api/novels/" in path:
            body = fx["novel"]
        else:
            body = None
        if body is None:
            return route.continue_()
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps(body), headers={"Cache-Control": "no-store"})

    page.route("**/api/novels", handle)
    page.route("**/api/novels?*", handle)
    page.route("**/api/novels/*", handle)
    page.route("**/api/chapters/*", handle)


def live_build(base):
    with urllib.request.urlopen(base + "/sw.js", timeout=90) as r:
        sw = r.read().decode("utf-8")
    import re
    return re.search(r"ASSET_VERSION = '([^']+)'", sw).group(1)


def run(base, themes):
    from playwright.sync_api import sync_playwright

    os.makedirs(SHOT_ROOT, exist_ok=True)
    shot_dir = os.path.join(SHOT_ROOT, "v17-live")
    os.makedirs(shot_dir, exist_ok=True)

    print("live ASSET_VERSION: %s" % live_build(base), flush=True)
    fx = capture_fixture()
    print("fixture captured: %d chapters" % len(fx["chapters"]), flush=True)

    results = {}
    geom = PORTRAIT
    safe_top = geom["insets"][0]
    with sync_playwright() as pw:
        browser = pw.webkit.launch()
        ctx = browser.new_context(
            viewport={"width": geom["width"], "height": geom["height"]},
            device_scale_factor=DPR, is_mobile=True, has_touch=True, user_agent=UA,
        )
        ctx.add_init_script(
            "document.addEventListener('DOMContentLoaded',()=>{"
            "const s=document.createElement('style');s.id='v17-insets';"
            "s.textContent=%s;document.head.appendChild(s);});" % json.dumps(inset_css(geom["insets"]))
        )
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        install_routes(page, fx)

        page.goto(base + "/", wait_until="load", timeout=120000)
        page.wait_for_timeout(8000)  # a sleeping free host needs a moment to register the device

        for theme in themes:
            page.evaluate(
                "(t)=>{const raw=localStorage.getItem('byob_settings');"
                "const s=raw?JSON.parse(raw):{};s.theme=t;"
                "localStorage.setItem('byob_settings',JSON.stringify(s));}", theme)
            page.goto(base + "/", wait_until="load", timeout=120000)
            page.wait_for_timeout(4000)

            shot = os.path.join(shot_dir, "10-library-%s.png" % theme)
            page.screenshot(path=shot)
            lib = page.evaluate(AUDIT_JS, safe_top)
            lib["strip"] = strip_is_flat(shot, safe_top)
            results["library-%s" % theme] = lib

            page.locator(".novel-card, .novel-item").first.click()
            page.wait_for_timeout(2500)
            shot = os.path.join(shot_dir, "20-book-%s.png" % theme)
            page.screenshot(path=shot)
            bk = page.evaluate(AUDIT_JS, safe_top)
            bk["strip"] = strip_is_flat(shot, safe_top)
            results["book-%s" % theme] = bk

            page.evaluate("()=>window.Reader && Reader.loadChapter('ch_v9_3')")
            page.wait_for_timeout(3000)
            page.evaluate("window.scrollTo(0,0)")
            page.wait_for_timeout(900)
            shot = os.path.join(shot_dir, "30-reader-top-%s.png" % theme)
            page.screenshot(path=shot)
            m = page.evaluate(MEASURE_JS)
            m["audit"] = page.evaluate(AUDIT_JS, safe_top)
            m["strip"] = strip_is_flat(shot, safe_top)

            page.evaluate("window.scrollTo(0, 1400)")
            page.wait_for_timeout(1500)
            shot = os.path.join(shot_dir, "31-reader-scrolled-%s.png" % theme)
            page.screenshot(path=shot)
            s = page.evaluate(MEASURE_JS)
            s["audit"] = page.evaluate(AUDIT_JS, safe_top)
            s["strip"] = strip_is_flat(shot, safe_top)
            m["scrolled"] = s
            results["reader-%s" % theme] = m

            page.evaluate("window.scrollTo(0,0)")
            page.wait_for_timeout(600)
            page.evaluate("()=>window.App && App.toggleMasterPanel && App.toggleMasterPanel()")
            page.wait_for_timeout(1800)
            shot = os.path.join(shot_dir, "40-settings-%s.png" % theme)
            page.screenshot(path=shot)
            st = page.evaluate(AUDIT_JS, safe_top)
            st["strip"] = strip_is_flat(shot, safe_top)
            results["settings-%s" % theme] = st
            page.keyboard.press("Escape")
            page.wait_for_timeout(800)

        results["_swCaches"] = page.evaluate("async()=>await caches.keys()")
        results["_build"] = page.evaluate(
            "async()=>{const r=await navigator.serviceWorker.getRegistration();"
            "return r?(r.active?'active':'installing'):'none';}")
        results["_pageErrors"] = errors
        browser.close()

    with open(os.path.join(shot_dir, "live.json"), "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)

    print("\n=== SUMMARY ===")
    for name, v in results.items():
        if name.startswith("_"):
            print("%-24s %s" % (name, v))
            continue
        strip = v.get("strip", {})
        line = "flat=%s share=%s clipped=%d textInStrip=%d blurredAtTop=%d scrim=%s" % (
            strip.get("flat"), strip.get("dominantShare"),
            len(v.get("clipped", v.get("audit", {}).get("clipped", []))),
            len(v.get("textInStrip", v.get("audit", {}).get("textInStrip", []))),
            len(v.get("blurredAtTop", v.get("audit", {}).get("blurredAtTop", []))),
            v.get("scrim", v.get("scrimHeight")))
        if name.startswith("reader-"):
            line += " headings=%s gap=%s" % (v.get("headingCount"), v.get("gapBelowBar"))
            s = v["scrolled"]
            line += " | scrolled headings=%s stripFlat=%s share=%s" % (
                s.get("headingCount"), s["strip"].get("flat"), s["strip"].get("dominantShare"))
        print("%-24s %s" % (name, line))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=LIVE)
    ap.add_argument("--themes", default="monochrome-dark,sepia-parchment")
    a = ap.parse_args()
    return run(a.base.rstrip("/"), [t for t in a.themes.split(",") if t])


if __name__ == "__main__":
    sys.exit(main())
