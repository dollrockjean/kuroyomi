"""Audit every screen of the app at the iPhone 16 Pro Max top, not just the reader.

Same simulated phone as tools/phone_shots.py (440x956, DPR 3, real 59/34 px insets injected
over the --safe-* variables). For each screen, scrolled to the top and scrolled down, it asks
one question: is anything readable hiding inside the 59 px status-bar strip, and is any sticky
or fixed bar sitting under the scrim that paints it?

  python tools/screen_audit.py <label> [--theme monochrome-dark]

Writes shots to tools/shots/<label>/ and prints the findings as JSON.
"""
import argparse
import json
import os
import sqlite3
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "tools"))

from phone_shots import (  # noqa: E402
    DPR, PORTRAIT, SHOT_ROOT, UA, book_payload, free_port, inset_css, start_server,
)

# Everything that can hold text or a control at the top of a screen. Anything in this list
# found inside the status-bar strip is a fault: the strip is painted over by the scrim.
AUDIT_JS = r"""
(safeTop) => {
  const px = v => Math.round(v * 10) / 10;
  const scrim = document.getElementById('safeAreaScrim');
  const scrimZ = scrim ? +getComputedStyle(scrim).zIndex : null;

  const out = { safeTop, scrimHeight: scrim ? px(scrim.getBoundingClientRect().height) : null,
                scrimZ, bars: [], clipped: [], blurredAtTop: [] };

  for (const el of document.querySelectorAll('header, .app-header, .reader-top-bar, .page-header, .panel-header, .modal-header, .mobile-quick-sheet, .master-panel, .reader-floating-bar')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
    const z = cs.zIndex === 'auto' ? 0 : +cs.zIndex;
    const blur = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
    const entry = {
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + (el.className || ''),
      top: px(r.top), bottom: px(r.bottom), position: cs.position, z,
      paddingTop: cs.paddingTop, backdrop: blur, bg: cs.backgroundColor,
    };
    out.bars.push(entry);
    // Under the scrim, reaching into the strip, and not padding its own content clear of it:
    // whatever it draws up there is painted over.
    const pad = parseFloat(cs.paddingTop) || 0;
    if (scrimZ !== null && z < scrimZ && r.top + pad < safeTop && r.bottom > 0) {
      out.clipped.push(entry);
    }
    // A translucent blur in the strip is what smears the status bar on a real iPhone.
    if (blur !== 'none' && r.top < safeTop + 2) out.blurredAtTop.push(entry);
  }

  // Text whose box reaches into the strip while painting above the scrim. (Hit-testing cannot
  // answer this: the scrim is pointer-events:none, so elementsFromPoint looks straight through it.)
  const over = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.children.length || el === scrim) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.top >= safeTop || r.bottom <= 0) continue;
    // Walk up for the nearest stacking z-index; anything below the scrim's is covered.
    let z = 0, node = el;
    while (node && node !== document.body) {
      const v = getComputedStyle(node).zIndex;
      if (v !== 'auto') { z = +v; break; }
      node = node.parentElement;
    }
    if (scrimZ === null || z >= scrimZ) {
      over.push(el.tagName.toLowerCase() + '.' + el.className + ' :: ' + txt.slice(0, 40));
    }
  }
  out.textInStrip = [...new Set(over)];
  return out;
}
"""


def strip_is_flat(shot_path, safe_top):
    """The blur question answered in pixels: is the status-bar strip one colour?

    Safari's smearing shows up as a spread of colours there. A hairline border from a panel
    edge is allowed; anything past a per-cent of the strip is not.
    """
    try:
        from PIL import Image
    except ImportError:
        return {"checked": False, "why": "Pillow not installed"}
    im = Image.open(shot_path).convert("RGB")
    strip = im.crop((0, 0, im.width, int(safe_top * DPR)))
    colours = sorted(strip.getcolors(maxcolors=1 << 24) or [], reverse=True)
    total = sum(n for n, _ in colours)
    share = colours[0][0] / total
    return {"checked": True, "flat": share > 0.99, "dominantShare": round(share, 6),
            "dominant": colours[0][1], "colours": len(colours)}


def audit(page, safe_top, name, shot_dir, findings):
    page.wait_for_timeout(500)
    shot = os.path.join(shot_dir, "%s.png" % name)
    page.screenshot(path=shot)
    result = page.evaluate(AUDIT_JS, safe_top)
    result["strip"] = strip_is_flat(shot, safe_top)
    findings[name] = result


def run(label, theme):
    from playwright.sync_api import sync_playwright

    shot_dir = os.path.join(SHOT_ROOT, label)
    os.makedirs(shot_dir, exist_ok=True)
    db_path = os.path.join(SHOT_ROOT, "audit-%s.db" % label)
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(db_path + suffix):
            os.remove(db_path + suffix)

    port = free_port()
    proc = start_server(db_path, port)
    base = "http://127.0.0.1:%d" % port
    safe_top = PORTRAIT["insets"][0]
    findings = {}
    try:
        with sync_playwright() as pw:
            browser = pw.webkit.launch()
            ctx = browser.new_context(
                viewport={"width": PORTRAIT["width"], "height": PORTRAIT["height"]},
                device_scale_factor=DPR, is_mobile=True, has_touch=True, user_agent=UA,
            )
            ctx.add_init_script(
                "document.addEventListener('DOMContentLoaded',()=>{"
                "const s=document.createElement('style');s.id='v12-insets';"
                "s.textContent=%s;document.head.appendChild(s);});"
                % json.dumps(inset_css(PORTRAIT["insets"]))
            )
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            page.goto(base + "/", wait_until="load")
            page.wait_for_timeout(2500)

            os.environ["READER_DB_PATH"] = db_path
            con = sqlite3.connect(db_path)
            uid = con.execute("select id from users order by created_at desc limit 1").fetchone()
            con.close()
            if not uid:
                raise RuntimeError("no user registered by the page")
            sys.path.insert(0, REPO)
            import database  # noqa: PLC0415
            database.import_backup_data(book_payload(uid[0]), uid[0])

            page.goto(base + "/", wait_until="load")
            page.evaluate(
                "(t)=>{const raw=localStorage.getItem('byob_settings');"
                "const s=raw?JSON.parse(raw):{};s.theme=t;"
                "localStorage.setItem('byob_settings',JSON.stringify(s));}", theme)
            page.goto(base + "/", wait_until="load")
            page.wait_for_timeout(2200)

            audit(page, safe_top, "10-library-top", shot_dir, findings)
            page.evaluate("window.scrollTo(0, 900)")
            audit(page, safe_top, "11-library-scrolled", shot_dir, findings)
            page.evaluate("window.scrollTo(0, 0)")

            page.locator(".novel-card, .novel-item").first.click()
            page.wait_for_timeout(1800)
            audit(page, safe_top, "20-book-top", shot_dir, findings)
            page.evaluate("window.scrollTo(0, 900)")
            audit(page, safe_top, "21-book-scrolled", shot_dir, findings)
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(400)

            # Settings / master panel, opened from the library screen.
            page.evaluate("()=>window.App && App.toggleMasterPanel && App.toggleMasterPanel()")
            page.wait_for_timeout(1400)
            audit(page, safe_top, "30-settings-panel", shot_dir, findings)
            page.keyboard.press("Escape")
            page.wait_for_timeout(800)

            findings["_pageErrors"] = errors
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

    print(json.dumps(findings, indent=2))
    with open(os.path.join(shot_dir, "audit.json"), "w", encoding="utf-8") as fh:
        json.dump(findings, fh, indent=2)

    bad = {k: v for k, v in findings.items()
           if isinstance(v, dict) and (v["clipped"] or v["textInStrip"] or v["blurredAtTop"]
                                       or v["strip"].get("flat") is False)}
    print("\nSCREENS WITH A TOP FAULT: %s" % (sorted(bad) or "none"))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("label")
    ap.add_argument("--theme", default="monochrome-dark")
    a = ap.parse_args()
    os.makedirs(SHOT_ROOT, exist_ok=True)
    return run(a.label, a.theme)


if __name__ == "__main__":
    sys.exit(main())
