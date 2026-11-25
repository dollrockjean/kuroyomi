"""Read the on-screen voice report the way Rocco's phone will, and photograph it.

The report is the one line that tells him which build the app is, whether that is the build the
server serves, which cache it came out of, and what the last question about his PC came back with.
A home-screen app has no address bar and no console, so this line is the only report the one device
that matters can give (2026-11-25, after three "fixed and live" nights it was still on Edge).

    python tools/v18_report_shot.py                 # against a local copy of this checkout
    python tools/v18_report_shot.py --live          # against the deployed site

Prints the report text as JSON and writes tools/shots/v18-report/<where>.png.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone_shots as ps  # noqa: E402 - needs the tools folder on the path first

SHOT_DIR = os.path.join(ps.SHOT_ROOT, "v18-report")
LIVE = "https://byob-webnovel-reader.onrender.com"

OPEN_PANEL_JS = """
() => {
  const panel = document.getElementById('masterSidePanel');
  if (panel) panel.classList.add('open');
  // The voice engine lives on the Audio tab of the side panel.
  const tab = Array.from(document.querySelectorAll('.master-tab-btn'))
    .find(b => /audio/i.test(b.textContent || ''));
  if (tab) tab.click();
  if (window.TTSEngine) window.TTSEngine.updateEngineUI();
  const els = Array.from(document.querySelectorAll('[data-engine-report]'));
  const shown = els.find(el => el.getBoundingClientRect().height > 0) || els[0] || null;
  if (shown) shown.scrollIntoView({ block: 'center' });
  return {
    count: els.length,
    texts: els.map(el => el.textContent),
    visible: shown ? shown.getBoundingClientRect().height > 0 : false,
    status: Array.from(document.querySelectorAll('[data-engine-status]')).map(e => e.textContent),
  };
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="shoot the deployed site instead")
    ap.add_argument("--wait", type=int, default=25, help="seconds to let the engine probe settle")
    ap.add_argument("--as-owner", action="store_true",
                    help="sign in with the account's sync key from this PC's keeper, so the report "
                         "says what Rocco's own phone would see rather than what a stranger sees")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    os.makedirs(SHOT_DIR, exist_ok=True)
    proc = None
    db_path = os.path.join(SHOT_DIR, "local.db")
    if args.live:
        base, where = LIVE, "live"
    else:
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(db_path + suffix):
                os.remove(db_path + suffix)
        port = ps.free_port()
        proc = ps.start_server(db_path, port)
        base, where = "http://127.0.0.1:%d" % port, "local"

    out = {"where": where, "base": base}
    try:
        with sync_playwright() as pw:
            browser = pw.webkit.launch()
            ctx = browser.new_context(
                viewport={"width": ps.PORTRAIT["width"], "height": ps.PORTRAIT["height"]},
                device_scale_factor=ps.DPR, is_mobile=True, has_touch=True, user_agent=ps.UA,
            )
            ctx.add_init_script(
                "document.addEventListener('DOMContentLoaded',()=>{"
                "const s=document.createElement('style');s.id='v18-insets';"
                "s.textContent=%s;document.head.appendChild(s);});"
                % json.dumps(ps.inset_css(ps.PORTRAIT["insets"]))
            )
            if args.as_owner:
                keeper_path = os.path.join(os.path.expanduser("~"), "BYoB Backups", "keeper",
                                           "keeper.json")
                with open(keeper_path, encoding="utf-8") as fh:
                    keeper = json.load(fh)
                ctx.add_init_script(
                    "try{localStorage.setItem('byob_sync_key', %s);}catch(e){}"
                    % json.dumps(keeper["sync_key"]))
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + "/", wait_until="load")
            page.wait_for_timeout(args.wait * 1000)
            out.update(page.evaluate(OPEN_PANEL_JS))
            page.wait_for_timeout(600)
            shot = os.path.join(SHOT_DIR, where + ".png")
            page.screenshot(path=shot)
            out["shot"] = shot
            out["page_errors"] = errors
            out["cache_names"] = page.evaluate("async () => (window.caches "
                                               "? await caches.keys() : [])")
            browser.close()
    finally:
        if proc:
            proc.terminate()
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
