"""Shoot the reader on a simulated iPhone 16 Pro Max and measure the top of the screen.

Playwright WebKit renders the page only, never Safari's chrome, and it cannot set
env(safe-area-inset-*). So the real iPhone 16 Pro Max insets are injected over the
--safe-* variables the CSS already funnels every inset through, which is the same
thing the phone does at runtime.

  python tools/phone_shots.py <label> [--themes a,b,c] [--landscape]

Writes shots to tools/shots/<label>/ and prints the measurements as JSON.
"""
import argparse
import json
import os
import socket
import subprocess
import sqlite3
import sys
import time
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT_ROOT = os.path.join(REPO, "tools", "shots")

# iPhone 16 Pro Max, iOS 18/26 Safari
PORTRAIT = {"width": 440, "height": 956, "insets": (59, 0, 34, 0)}  # top, right, bottom, left
LANDSCAPE = {"width": 956, "height": 440, "insets": (0, 59, 21, 59)}
DPR = 3
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"
)

DEFAULT_THEMES = ["monochrome-dark", "monochrome-light", "webnovel-ocean", "sepia-parchment"]

# The shape that broke on Rocco's phone: an EPUB whose chapter 3 was two files, the
# first holding only the running header and the second the same header plus "[2]".
DOUBLE_HEADING = (
    '<h2 class="reader-heading" data-pid="0" id="p-0">Chapter 3: Julien D. Evenus [2]</h2>\n'
    '<h2 class="reader-heading" data-pid="1" id="p-1">Chapter 3: Julien D. Evenus [2]</h2>\n'
    + "\n".join(
        '<p class="reader-paragraph" data-pid="%d" id="p-%d">%s</p>'
        % (i + 2, i + 2, "The hall of the Evenus estate held its breath. " * 4)
        for i in range(40)
    )
)
PLAIN_BODY = "\n".join(
    '<p class="reader-paragraph" data-pid="%d" id="p-%d">%s</p>'
    % (i, i, "Snow fell over the broken gate for the third night running. " * 4)
    for i in range(40)
)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def book_payload(user_id):
    nid, vid = "nov_v9test", "vol_v9test"
    now = time.time()
    chapters = []
    for i in range(1, 6):
        if i == 3:
            title, html = "Chapter 3: Julien D. Evenus [2]", DOUBLE_HEADING
        else:
            title = "Chapter %d: The Long Road" % i
            html = (
                '<h2 class="reader-heading" data-pid="0" id="p-0">%s</h2>\n' % title
            ) + PLAIN_BODY
        chapters.append({
            "id": "ch_v9_%d" % i,
            "novel_id": nid,
            "volume_id": vid,
            "chapter_index": i,
            "global_index": i,
            "title": title,
            "content_html": html,
            "word_count": len(html.split()),
        })
    return {
        "version": 1,
        "app": "byob",
        "exported_at": now,
        "user_id": user_id,
        "novels": [{
            "id": nid, "title": "Advent of the Three Calamities", "author": "Test",
            "description": "Layout fixture.", "user_id": user_id,
            "created_at": now, "updated_at": now,
        }],
        "volumes": [{
            "id": vid, "novel_id": nid, "volume_number": 1, "title": "Volume 1",
            "file_name": "fixture.epub", "total_chapters": len(chapters), "created_at": now,
        }],
        "chapters": chapters,
    }


def start_server(db_path, port):
    env = dict(os.environ, READER_DB_PATH=db_path, PORT=str(port), BYOB_DISABLE_KOKORO="1")
    log = open(os.path.join(SHOT_ROOT, "server.log"), "wb")
    proc = subprocess.Popen(
        [sys.executable, os.path.join(REPO, "server.py")],
        cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    for _ in range(80):
        try:
            s = socket.create_connection(("127.0.0.1", port), 0.4)
            s.close()
            return proc
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError("server died early; see tools/shots/server.log")
            time.sleep(0.25)
    raise RuntimeError("server never came up")


def inset_css(insets):
    top, right, bottom, left = insets
    return (
        ":root{--safe-top:%dpx !important;--safe-right:%dpx !important;"
        "--safe-bottom:%dpx !important;--safe-left:%dpx !important;}"
        % (top, right, bottom, left)
    )


MEASURE_JS = r"""
() => {
  const px = v => Math.round(v * 10) / 10;
  const bar = document.getElementById('readerTopBar');
  const content = document.getElementById('readerContent');
  const wrapper = document.getElementById('readerBodyWrapper');
  const scrim = document.getElementById('safeAreaScrim');
  const barRect = bar ? bar.getBoundingClientRect() : null;
  const firstBlock = content ? content.firstElementChild : null;
  const blockRect = firstBlock ? firstBlock.getBoundingClientRect() : null;
  const headings = content
    ? Array.from(content.querySelectorAll('.reader-heading, h1, h2, h3')).map(h => h.textContent.trim())
    : [];
  const cs = bar ? getComputedStyle(bar) : null;
  return {
    barTop: barRect ? px(barRect.top) : null,
    barBottom: barRect ? px(barRect.bottom) : null,
    barBg: cs ? cs.backgroundColor : null,
    barBackdrop: cs ? (cs.backdropFilter || cs.webkitBackdropFilter) : null,
    wrapperPadTop: wrapper ? getComputedStyle(wrapper).paddingTop : null,
    firstBlockClass: firstBlock ? firstBlock.className : null,
    firstBlockTop: blockRect ? px(blockRect.top) : null,
    gapBelowBar: (barRect && blockRect) ? px(blockRect.top - barRect.bottom) : null,
    headings: headings.slice(0, 6),
    headingCount: headings.length,
    scrim: scrim ? px(scrim.getBoundingClientRect().height) : null,
    wrapperTop: wrapper ? px(wrapper.getBoundingClientRect().top) : null,
    contentTop: content ? px(content.getBoundingClientRect().top) : null,
    aboveContent: wrapper ? Array.from(wrapper.children)
      .filter(el => el.id !== 'readerContent' && el.compareDocumentPosition(content) & 4)
      .map(el => el.className + ':' + px(el.getBoundingClientRect().height)) : null,
    firstBlockMarginTop: firstBlock ? getComputedStyle(firstBlock).marginTop : null,
    chain: (() => {
      const out = [];
      let el = wrapper;
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        out.push([el.tagName + '.' + el.className, px(el.getBoundingClientRect().top),
                  cs.paddingTop, cs.marginTop, cs.display]);
        el = el.parentElement;
      }
      return out;
    })(),
    themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
    bodyPadTop: getComputedStyle(document.body).paddingTop,
    docBg: getComputedStyle(document.documentElement).backgroundColor,
  };
}
"""


def run(label, themes, landscape):
    from playwright.sync_api import sync_playwright

    shot_dir = os.path.join(SHOT_ROOT, label)
    os.makedirs(shot_dir, exist_ok=True)
    db_path = os.path.join(SHOT_ROOT, "v9-%s.db" % uuid.uuid4().hex[:8])
    for suffix in ("", "-wal", "-shm"):
        p = db_path + suffix
        if os.path.exists(p):
            os.remove(p)

    port = free_port()
    proc = start_server(db_path, port)
    base = "http://127.0.0.1:%d" % port
    results = {}
    geom = LANDSCAPE if landscape else PORTRAIT
    try:
        with sync_playwright() as pw:
            browser = pw.webkit.launch()
            ctx = browser.new_context(
                viewport={"width": geom["width"], "height": geom["height"]},
                device_scale_factor=DPR,
                is_mobile=True,
                has_touch=True,
                user_agent=UA,
            )
            ctx.add_init_script(
                "document.addEventListener('DOMContentLoaded',()=>{"
                "const s=document.createElement('style');s.id='v9-insets';"
                "s.textContent=%s;document.head.appendChild(s);});" % json.dumps(inset_css(geom["insets"]))
            )
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            page.goto(base + "/", wait_until="load")
            page.wait_for_timeout(2500)

            # The page registers a device on first load; hand that user the fixture book.
            sys.path.insert(0, REPO)
            os.environ["READER_DB_PATH"] = db_path
            con = sqlite3.connect(db_path)
            uid = con.execute("select id from users order by created_at desc limit 1").fetchone()
            con.close()
            if not uid:
                raise RuntimeError("no user registered by the page")
            import database  # noqa: PLC0415 - needs READER_DB_PATH set first
            database.import_backup_data(book_payload(uid[0]), uid[0])

            for theme in themes:
                page.goto(base + "/", wait_until="load")
                page.evaluate(
                    "(t)=>{const raw=localStorage.getItem('byob_settings');"
                    "const s=raw?JSON.parse(raw):{};s.theme=t;"
                    "localStorage.setItem('byob_settings',JSON.stringify(s));}",
                    theme,
                )
                page.goto(base + "/", wait_until="load")
                page.wait_for_timeout(2200)
                page.screenshot(path=os.path.join(shot_dir, "01-library-%s.png" % theme))

                card = page.locator(".novel-card, .novel-item").first
                card.click()
                page.wait_for_timeout(1800)
                page.screenshot(path=os.path.join(shot_dir, "02-chapters-%s.png" % theme))

                # Chapter 3 is the fixture with the doubled running header.
                page.evaluate("()=>window.Reader && Reader.loadChapter('ch_v9_3')")
                page.wait_for_timeout(2200)
                page.evaluate("window.scrollTo(0,0)")
                page.wait_for_timeout(700)
                page.screenshot(path=os.path.join(shot_dir, "03-reader-top-%s.png" % theme))
                results[theme] = page.evaluate(MEASURE_JS)

                page.evaluate("window.scrollTo(0, 1400)")
                page.wait_for_timeout(1200)
                page.screenshot(path=os.path.join(shot_dir, "04-reader-scrolled-%s.png" % theme))
                results[theme]["scrolled"] = page.evaluate(MEASURE_JS)

                if theme == themes[0]:
                    page.evaluate("window.scrollTo(0,0)")
                    page.wait_for_timeout(600)
                    if page.locator("#mobileQuickSheet").count():
                        page.evaluate(
                            "()=>window.App && App.openMobileQuickSheet && App.openMobileQuickSheet()"
                        )
                        page.wait_for_timeout(1200)
                        page.screenshot(path=os.path.join(shot_dir, "05-quicksheet-%s.png" % theme))
                        page.keyboard.press("Escape")
                        page.wait_for_timeout(600)
                    page.evaluate("()=>window.App && App.toggleMasterPanel && App.toggleMasterPanel()")
                    page.wait_for_timeout(1200)
                    page.screenshot(path=os.path.join(shot_dir, "06-menu-%s.png" % theme))

            results["_pageErrors"] = errors
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    print(json.dumps(results, indent=2))
    with open(os.path.join(shot_dir, "measurements.json"), "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("label")
    ap.add_argument("--themes", default=",".join(DEFAULT_THEMES))
    ap.add_argument("--landscape", action="store_true")
    a = ap.parse_args()
    os.makedirs(SHOT_ROOT, exist_ok=True)
    return run(a.label, [t for t in a.themes.split(",") if t], a.landscape)


if __name__ == "__main__":
    sys.exit(main())
