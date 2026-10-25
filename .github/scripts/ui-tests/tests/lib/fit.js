// fit.js — fitProblems: does an open overlay fit the visible screen, and can a finger
// scroll what it holds? (design.md → iPhone and iPad; test.md → UI coverage
// gates, *Overlays fit and scroll*.) Takes a locator for the overlays to check
// (a dialog, a pop-over, a ⋮ menu, a type-ahead list) and returns a list of
// problems in words, empty when they all pass. DISMISS calls it for every
// overlay a button opens; a project calls it from its own S5+ for an overlay
// that opens by typing (a /command list, an @mention, an autocomplete), which
// no generic scenario can reach. It runs in every project, and the one that
// matters is `iphone`: it is WebKit, the engine every iPhone browser uses.
//
// What it reports, each a way the 2026-10-25 board-post list failed on an
// iPhone (cut off, and a finger could not scroll it):
//   * OFF SCREEN — an overlay pinned to the screen (position: fixed or sticky
//     on it or an ancestor, a modal <dialog>, an open popover) runs past the
//     visible area (window.visualViewport, which on a phone shrinks for the
//     on-screen keyboard), and no box between that part and the overlay
//     scrolls, so nothing can bring it into view. That includes an overlay
//     opened wholly off the screen (under the keyboard, say). Inside one, an
//     element entirely outside the screen is not counted: that is how
//     visually-hidden text is placed.
//   * CUT OFF — a box holds more than it shows (by more than 8px, and it is at
//     least 24px tall: smaller is an icon or visually-hidden text) and its
//     overflow-y is hidden or clip, so the rest cannot be reached at all.
//   * DOES NOT SCROLL — a box that should scroll (overflow-y auto or scroll,
//     content taller than it) did not move when its scrollTop was set: a
//     script put it back, or something else holds it.
//   * NO TOUCH SCROLL — touch-action on the box or an ancestor leaves out
//     pan-y, or a touchmove listener cancels the event (the usual script
//     "scroll lock"). Either stops a finger while a mouse wheel still works,
//     which is how it passes a laptop and fails a phone. The touchmove probe
//     dispatches a synthetic touchstart/touchmove/touchend inside the box and
//     needs TouchEvent, which a touch-enabled project (iphone, mobile-chrome,
//     tablet) has and the desktop project does not.
//
// Bounded: one evaluateAll, raced against FIT_MS, so a page that hangs it
// costs that and reports it. The scrollTop it moves is put back. A check that
// timed out or threw returns one line starting FIT_INCOMPLETE: that says the
// check did not finish, not that the overlay is wrong (a cold WebKit took more
// than 2s on its first call in CI, 2026-10-25), so a caller records it as a
// budget note, never as a defect.
//
// No imports, on purpose: this repo's own CI proves it against a fixture page
// with plain `playwright` (.github/scripts/check-fit-cases.js), where the
// kit's @playwright/test is not installed.
const FIT_MS = 2000;
const FIT_INCOMPLETE = 'FIT CHECK ';
async function fitProblems(locator, { timeout = FIT_MS } = {}) {
  const run = locator.evaluateAll(async (els) => {
    const problems = [];
    const name = el => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '')
      + [...el.classList].slice(0, 2).map(c => `.${c}`).join('')
      + (el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '');
    const shown = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const vv = window.visualViewport;
    const view = vv
      ? { top: vv.offsetTop, left: vv.offsetLeft, bottom: vv.offsetTop + vv.height, right: vv.offsetLeft + vv.width }
      : { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    const scrolls = cs => cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    const clips = cs => cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    const pinned = el => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') return true;
        try { if (n.matches(':modal, :popover-open')) return true; } catch { /* older engine: no :modal */ }
      }
      return false;
    };
    // Two frames, the time a script's scroll listener needs to answer (two
    // frames measured ~150ms in headless WebKit, ~25ms in Chromium). Capped at
    // 1s, so a page that never paints still lets the check end.
    const frame = () => new Promise(r => {
      setTimeout(r, 1000);
      requestAnimationFrame(() => requestAnimationFrame(r));
    });
    for (const root of els) {
      if (!shown(root)) continue;
      const isPinned = pinned(root);
      const nodes = [root, ...root.querySelectorAll('*')].slice(0, 2000);
      for (const el of nodes) {
        if (!shown(el)) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        // OFF SCREEN: only where nothing between it and the overlay can scroll.
        if (isPinned) {
          const inside = r.bottom > view.top && r.top < view.bottom && r.right > view.left && r.left < view.right;
          const past = r.top < view.top - 1 || r.bottom > view.bottom + 1 || r.left < view.left - 1 || r.right > view.right + 1;
          let held = false;
          if (el !== root) {
            for (let n = el.parentElement; n; n = n.parentElement) {
              const ns = getComputedStyle(n);
              if (scrolls(ns) || clips(ns)) { held = true; break; }
              if (n === root) break;
            }
          }
          if ((inside || el === root) && past && !held) {
            problems.push(`OFF SCREEN: ${name(el)} runs past the visible screen (box ${Math.round(r.top)}–${Math.round(r.bottom)} x ${Math.round(r.left)}–${Math.round(r.right)}, screen ${Math.round(view.top)}–${Math.round(view.bottom)} x ${Math.round(view.left)}–${Math.round(view.right)}) and nothing scrolls it into view`);
          }
        }
        const over = el.scrollHeight - el.clientHeight;
        if (el.clientHeight >= 24 && over > 8 && clips(cs)) {
          problems.push(`CUT OFF: ${name(el)} shows ${el.clientHeight}px of ${el.scrollHeight}px and cannot scroll (overflow-y: ${cs.overflowY})`);
        }
        if (over > 1 && scrolls(cs)) {
          // Toward whichever end has room: a list already scrolled to its
          // bottom (an autocomplete showing its selected option) moves up.
          const before = el.scrollTop;
          const down = over - before >= 1;
          el.scrollTop = down ? before + Math.min(over - before, 40) : before - Math.min(before, 40);
          await frame();
          const moved = down ? el.scrollTop > before : el.scrollTop < before;
          el.scrollTop = before;
          if (!moved) problems.push(`DOES NOT SCROLL: ${name(el)} holds ${el.scrollHeight}px in ${el.clientHeight}px, and setting its scrollTop did not move it`);
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const ta = getComputedStyle(n).touchAction;
            if (ta && ta !== 'auto' && ta !== 'manipulation' && !ta.includes('pan-y')) {
              problems.push(`NO TOUCH SCROLL: ${name(el)} scrolls, but touch-action: ${ta} on ${name(n)} stops a finger scrolling it`);
              break;
            }
          }
          if (typeof TouchEvent === 'function') {
            const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 20);
            // A Touch: the constructor where the engine has one (Chromium); WebKit
            // calls it illegal and still has document.createTouch. With neither,
            // the events go without touch lists, which still shows a listener
            // that cancels them.
            const touch = (yy) => {
              try { return new Touch({ identifier: 7, target: el, clientX: x, clientY: yy, pageX: x + scrollX, pageY: yy + scrollY }); } catch { /* next */ }
              try { return document.createTouch(window, el, 7, x + scrollX, yy + scrollY, x, yy); } catch { return null; }
            };
            const send = (type, t, list) => {
              let ev;
              try {
                ev = new TouchEvent(type, t
                  ? { bubbles: true, cancelable: true, composed: true, touches: list, targetTouches: list, changedTouches: [t] }
                  : { bubbles: true, cancelable: true, composed: true });
              } catch {
                ev = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true });
              }
              return el.dispatchEvent(ev);
            };
            try {
              const t0 = touch(y), t1 = touch(y - 10);
              send('touchstart', t0, t0 ? [t0] : []);
              const allowed = send('touchmove', t1, t1 ? [t1] : []);
              send('touchend', t1, []);
              if (!allowed) problems.push(`NO TOUCH SCROLL: ${name(el)} scrolls, but a touchmove listener cancels the event, so a finger cannot scroll it (a script scroll lock?)`);
            } catch { /* this engine cannot build a TouchEvent: not a touch project */ }
          }
        }
      }
    }
    return [...new Set(problems)];
  });
  let timer;
  const cap = new Promise(resolve => { timer = setTimeout(() => resolve([`${FIT_INCOMPLETE}TIMED OUT after ${timeout}ms`]), timeout); });
  try {
    return await Promise.race([run.catch(e => [`${FIT_INCOMPLETE}FAILED: ${String(e && e.message || e).split('\n')[0]}`]), cap]);
  } finally {
    clearTimeout(timer);
  }
}

export { fitProblems, FIT_MS, FIT_INCOMPLETE };
