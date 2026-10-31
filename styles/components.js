/* ── components.js — the behaviour every page shares ────────────────────────
   The HOUSE script (design.md, owner rulings 2026-10-19; #471), the half of the
   house components that CSS cannot carry. ONE copy per project, at
   styles/components.js beside tokens.css and components.css, loaded by every
   page and never copied into one:

     <script src="styles/components.js" defer></script>

   Plain JS, no build, no dependency, no outside request. It binds to the class
   names in components.css and to nothing a page invents. It writes text with
   textContent only, never innerHTML (design.md -> Accessibility).

   What it does, by design.md section:
     §3   House.icon(name)            one Lucide line-icon set; <span data-icon="archive"> too
     §4   the aria-disabled guard     cancels click, Enter and Space on [aria-disabled="true"]
                                      and says why (its title) in an inline message
          House.busy(button, 'Saving…') -> restore()
     §5   House.menu(button)          the ⋮ menu: .menu-btn[aria-controls] -> .menu-pop
     §6   House.compare(a, b, dir)    the one comparator, blanks last both ways
          House.sortable(table)       .th-sort headers, aria-sort, " ▲" / " ▼"
     §7   House.archived(host, opts)  the one Archived (N) renderer
          House.fit(pop, anchor)      keeps a pop-over inside the window
     §9   House.confirm(opts)         yes / no             -> Promise<boolean>
          House.ask(opts)             typed text, or null  -> Promise<string|null>
          House.notice(opts)          one Close button     -> Promise<void>
     §10  House.dialog.open(el, opts) focus in, Tab kept in, Esc / backdrop / ×,
                                      focus back to the opener; also for a page's
                                      own dialog markup (a form, a rename)
     §11  House.segmented(tablist)    roving tabindex, ← → Home End, panels
     §15  House.empty(host, opts)     the empty state
     §16  House.typeahead(field, list) the type-ahead list: combobox roles, ↓ ↑ Enter
                                      Esc, a tap; placed by the fit; "house:pick"
     §18  House.message(target, text) the inline message beside what it is about
          House.toast(text)           success toast; { error: true } for a red one

   House.init(root) binds the declarative markup (data-icon, .menu-btn, the
   segmented controls, sortable tables) under root. It runs once by itself when
   the page has parsed; call it again for markup a page adds later. Binding
   twice is harmless.

   Proven in claude.directives by .github/scripts/check-house-script.js against
   .github/house-fixture/index.html. A change here changes that check too. */
(function () {
  'use strict';
  if (window.House) return;   // loaded twice: the first copy stays in charge

  let seq = 0;
  const uid = p => `house-${p}-${++seq}`;
  const bound = new WeakSet();
  const once = el => (bound.has(el) ? false : (bound.add(el), true));

  /* ── §3 Icons: one line-icon set (Lucide shapes) ───────────────────────────
     Shapes from Lucide (https://lucide.dev), ISC License, Copyright (c) Lucide
     Contributors: "Permission to use, copy, modify, and/or distribute this
     software for any purpose with or without fee is hereby granted, provided
     that the above copyright notice and this permission notice appear in all
     copies." An act the set lacks gets its Lucide shape added HERE, never drawn
     inline on a page. */
  const ICONS = {
    plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
    pencil: [['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }], ['path', { d: 'm15 5 4 4' }]],
    archive: [['rect', { width: 20, height: 5, x: 2, y: 3, rx: 1 }], ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' }], ['path', { d: 'M10 12h4' }]],
    trash: [['path', { d: 'M3 6h18' }], ['path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }], ['path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }], ['line', { x1: 10, x2: 10, y1: 11, y2: 17 }], ['line', { x1: 14, x2: 14, y1: 11, y2: 17 }]],
    x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    'more-vertical': [['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 5, r: 1 }], ['circle', { cx: 12, cy: 19, r: 1 }]],
    upload: [['path', { d: 'M12 13v8' }], ['path', { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }], ['path', { d: 'm8 17 4-4 4 4' }]],
    paperclip: [['path', { d: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' }]],
    camera: [['path', { d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z' }], ['circle', { cx: 12, cy: 13, r: 3 }]],
    download: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '7 10 12 15 17 10' }], ['line', { x1: 12, x2: 12, y1: 15, y2: 3 }]],
    search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
    lock: [['rect', { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]],
    star: [['polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' }]],
    grip: [['circle', { cx: 9, cy: 12, r: 1 }], ['circle', { cx: 9, cy: 5, r: 1 }], ['circle', { cx: 9, cy: 19, r: 1 }], ['circle', { cx: 15, cy: 12, r: 1 }], ['circle', { cx: 15, cy: 5, r: 1 }], ['circle', { cx: 15, cy: 19, r: 1 }]],
    'arrow-left': [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]],
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  // Always decoration: the button that carries it has aria-label AND title (§3).
  function icon(name) {
    const shapes = ICONS[name];
    if (!shapes) throw new Error(`House.icon: no icon named "${name}"; add its Lucide shape to the set in styles/components.js (design.md §3)`);
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false', 'data-icon-name': name,
    });
    for (const [tag, attrs] of shapes) svg.append(svgEl(tag, attrs));
    return svg;
  }

  /* ── §18 Messages: the inline message beside what it is about ──────────────
     A page that wants the message in a set place gives the target an
     aria-describedby naming an empty .inline-msg (hidden until used); otherwise
     the message goes right after the target's .field, or after the target. An
     error is role="alert" and marks a field aria-invalid; text "" clears it. */
  function messageFor(target) {
    const ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.classList.contains('inline-msg')) return el;
    }
    return null;
  }
  const isField = el => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  function message(target, text, { kind = 'err', after } = {}) {
    let msg = messageFor(target);
    if (!text) {
      if (msg) {
        if (msg.dataset.houseMsg) {
          msg.remove();
          const ids = target.getAttribute('aria-describedby').split(/\s+/).filter(id => id && id !== msg.id);
          if (ids.length) target.setAttribute('aria-describedby', ids.join(' '));
          else target.removeAttribute('aria-describedby');
        } else { msg.textContent = ''; msg.hidden = true; }
      }
      target.removeAttribute('aria-invalid');
      return null;
    }
    if (!msg) {
      msg = document.createElement('div');
      msg.className = 'inline-msg';
      msg.id = uid('msg');
      msg.dataset.houseMsg = '1';
      (after || target.closest('.field') || target).after(msg);
      const ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      target.setAttribute('aria-describedby', [...ids, msg.id].join(' '));
    }
    msg.classList.toggle('err', kind === 'err');
    msg.classList.toggle('ok', kind === 'ok');
    msg.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    msg.hidden = false;
    msg.textContent = text;
    if (kind === 'err' && isField(target)) target.setAttribute('aria-invalid', 'true');
    else target.removeAttribute('aria-invalid');
    return msg;
  }

  // A toast: success disappears by itself and is announced politely; an error
  // toast is red, announced, and stays longer the longer it is (§18). One at a
  // time. The text lands a moment after the live region, so it is announced.
  let currentToast = null;
  function toast(text, { error = false } = {}) {
    if (currentToast) currentToast.remove();
    const t = document.createElement('div');
    t.className = error ? 'toast err' : 'toast';
    t.setAttribute('role', error ? 'alert' : 'status');
    t.setAttribute('aria-live', error ? 'assertive' : 'polite');
    document.body.append(t);
    currentToast = t;
    setTimeout(() => { t.textContent = text; }, 30);
    const ms = error ? Math.max(6000, 80 * text.length) : 4000;
    setTimeout(() => { t.remove(); if (currentToast === t) currentToast = null; }, ms);
    return t;
  }

  // §4 While working: natively disabled, showing its busy label ("Saving…").
  // Returns the function that puts the button back as it was.
  function busy(button, label) {
    const kids = [...button.childNodes];
    const was = button.disabled;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = label;
    return () => {
      button.replaceChildren(...kids);
      button.disabled = was;
      button.removeAttribute('aria-busy');
    };
  }

  /* ── §4 The aria-disabled guard ─────────────────────────────────────────────
     A button that will become pressable stays focusable with
     aria-disabled="true"; ARIA alone stops nothing, so its click, Enter and
     Space are cancelled here, before any handler of the page's runs (window,
     capture phase), and its title is said in an inline message. A page that
     wants to do more listens for "house:blocked" on the element. */
  const blockedBy = e => (e.target instanceof Element ? e.target.closest('[aria-disabled="true"]') : null);
  function block(e, el) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const why = el.getAttribute('title');
    if (why) message(el, why, { kind: 'info' });
    el.dispatchEvent(new CustomEvent('house:blocked', { bubbles: true }));
  }
  window.addEventListener('click', e => { const el = blockedBy(e); if (el) block(e, el); }, true);
  window.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = blockedBy(e);
    if (el) block(e, el);
  }, true);

  /* ── §7 / §5 The shared fit: a pop-over stays inside the visible window ─────
     Below its button where it fits, else above where the room is; aligned to
     the button's start (Archived) or end (⋮), then moved sideways to stay 8px
     inside the window; a list longer than the room scrolls inside it. The
     pop-over is position: fixed (components.css), so no sidebar or card edge
     clips it. "The window" is the VISUAL viewport where the browser has one: on
     an iPhone the on-screen keyboard shrinks only window.visualViewport, so a
     pop-over opened from a field would otherwise land under the keyboard. Its
     offsets are in the same layout-viewport coordinates as
     getBoundingClientRect() and position: fixed. */
  const GAP = 8;
  function visible() {
    const vv = window.visualViewport;
    if (vv) return { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height };
    const de = document.documentElement;
    return { x: 0, y: 0, w: de.clientWidth, h: de.clientHeight };
  }
  function fit(pop, anchor, { align = 'start' } = {}) {
    // Measuring clears the max-height, which clamps a scrolled list's
    // scrollTop to the taller box; it is put back once the height is.
    const scrolled = pop.scrollTop;
    pop.style.maxHeight = '';
    pop.style.width = '';
    pop.style.left = '0px';
    pop.style.top = '0px';
    const v = visible();
    const vw = v.w;
    const a = anchor.getBoundingClientRect();
    const w = Math.min(pop.offsetWidth, vw - 2 * GAP);
    const h = pop.offsetHeight;
    const below = v.y + v.h - a.bottom - 2 * GAP;
    const above = a.top - v.y - 2 * GAP;
    let top;
    if (h <= below || below >= above) {
      const room = Math.max(below, 0);
      if (h > room) pop.style.maxHeight = `${room}px`;
      top = a.bottom + GAP;
    } else {
      const room = Math.max(above, 0);
      if (h > room) pop.style.maxHeight = `${room}px`;
      top = a.top - GAP - Math.min(h, room);
    }
    // An anchor scrolled out of view would carry the pop-over off the window
    // with it; it is held inside instead (a disclosure closes, below).
    top = Math.max(v.y + GAP, Math.min(top, v.y + v.h - GAP - pop.offsetHeight));
    let left = align === 'end' ? a.right - w : a.left;
    left = Math.max(v.x + GAP, Math.min(left, v.x + vw - GAP - w));
    pop.style.width = pop.offsetWidth > vw - 2 * GAP ? `${w}px` : '';
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.scrollTop = scrolled;
  }

  /* ── Disclosures: the Archived (N) pop-over and the ⋮ menu ──────────────────
     A button with aria-expanded and aria-controls shows a pop-over. Esc or a
     press outside closes it, and Esc returns focus to the button; focus that
     leaves both closes it too. One open at a time. */
  const openPops = [];
  function disclosure(btn, pop, { align = 'start', focusFirst = false } = {}) {
    if (!pop.id) pop.id = uid('pop');
    btn.setAttribute('aria-controls', pop.id);
    btn.setAttribute('aria-expanded', 'false');
    pop.hidden = true;
    const d = {
      btn, pop, align,
      isOpen: () => !pop.hidden,
      show() {
        for (const o of [...openPops]) if (o !== d) o.hide(false);
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        fit(pop, btn, { align });
        if (!openPops.includes(d)) openPops.push(d);
        if (focusFirst) {
          const first = focusables(pop)[0];
          if (first) first.focus();
        }
      },
      hide(returnFocus) {
        if (pop.hidden) return;
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        openPops.splice(openPops.indexOf(d), 1);
        if (returnFocus && btn.isConnected && !btn.hidden) btn.focus();
      },
      // Its button scrolled out of view: the pop-over closes rather than float
      // away from it, and focus inside it goes back to the button unscrolled.
      refit() {
        if (pop.hidden) return;
        const a = btn.getBoundingClientRect();
        const v = visible();
        if (a.bottom <= v.y || a.top >= v.y + v.h) {
          const had = pop.contains(document.activeElement);
          d.hide(false);
          if (had && btn.isConnected) btn.focus({ preventScroll: true });
          return;
        }
        fit(pop, btn, { align });
      },
    };
    btn.addEventListener('click', () => (d.isOpen() ? d.hide(false) : d.show()));
    return d;
  }
  const inside = (d, node) => d.pop.contains(node) || d.btn.contains(node);
  document.addEventListener('pointerdown', e => {
    for (const d of [...openPops]) if (!inside(d, e.target)) d.hide(false);
  }, true);
  document.addEventListener('focusin', e => {
    for (const d of [...openPops]) if (!inside(d, e.target)) d.hide(false);
  });
  // A scroll inside a pop-over (its own long list) moves nothing it is placed by.
  const refitAll = e => {
    for (const d of [...openPops]) if (!(e && e.type === 'scroll' && e.target instanceof Node && d.pop.contains(e.target))) d.refit();
  };
  window.addEventListener('resize', refitAll);
  window.addEventListener('scroll', refitAll, true);
  // The keyboard opening or closing, and a pinch zoom, move only the visual viewport.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', refitAll);
    window.visualViewport.addEventListener('scroll', refitAll);
  }

  /* ── §5 The ⋮ menu: a disclosure of native buttons, not an ARIA menu ─────────
     Markup: <button class="btn btn-icon menu-btn" aria-label="More actions"
     title="More actions" aria-controls="m1"> + <div class="menu-pop" id="m1">
     of <button class="menu-item">. Opening moves focus to the first action; Tab
     moves through them. Pressing an action closes the menu and puts focus back
     on ⋮ BEFORE the action's own handler runs, so a confirmation it opens
     returns there. */
  const menus = new WeakMap();
  function menu(btn) {
    if (menus.has(btn)) return menus.get(btn);
    const pop = document.getElementById(btn.getAttribute('aria-controls') || '');
    if (!pop) throw new Error('House.menu: the ⋮ button needs aria-controls naming its .menu-pop');
    const d = disclosure(btn, pop, { align: 'end', focusFirst: true });
    pop.addEventListener('click', e => {
      if (e.target instanceof Element && e.target.closest('.menu-item')) d.hide(true);
    }, true);
    menus.set(btn, d);
    return d;
  }

  /* ── §16 The type-ahead list: choices that filter as you type ───────────────
     House.typeahead(field, list, { autoSelect }) -> { update, close, isOpen, active }
     field is the <input> or <textarea> typed in; list is its .list-pop. The PAGE
     owns the words: as the text changes it fills list with .list-option rows
     (an optional .list-head first) and empties it when nothing matches. This
     owns the rest. The roles: field a combobox, list a listbox, each row an
     option. The list opens under the focused field whenever it has choices
     (placed by the shared fit, so above the iPhone keyboard when below has no
     room) and closes when it has none. ↓ ↑ move through the choices, wrapping,
     with the active one kept in view inside the list; Enter or a tap picks one;
     Esc or a press outside closes it. Focus never leaves the field, so a phone's
     keyboard stays up, and a finger scrolls the list as any other. A pick
     closes the list and fires "house:pick" ({ option }) on the field; what it
     writes into the field is the page's. The first choice is active as the list
     opens, so Enter takes it; { autoSelect: false } leaves none active until ↓
     or ↑, and Enter then reaches the field. With the list closed (Esc), ↓
     reopens it from an <input>, Alt+↓ from a <textarea>, where a bare ↓ moves
     the caret. Home and End stay the caret's. An option with
     aria-disabled="true" is skipped and cannot be picked. */
  const typeaheads = new WeakMap();
  function typeahead(field, list, { autoSelect = true } = {}) {
    if (typeaheads.has(field)) return typeaheads.get(field);
    if (!list.id) list.id = uid('list');
    list.setAttribute('role', 'listbox');
    field.setAttribute('role', 'combobox');
    field.setAttribute('aria-autocomplete', 'list');
    field.setAttribute('aria-controls', list.id);
    field.setAttribute('aria-expanded', 'false');
    list.hidden = true;
    let current = null;
    const rows = () => [...list.querySelectorAll('.list-option')];
    const choices = () => rows().filter(o => !o.hidden && o.getAttribute('aria-disabled') !== 'true');
    function activate(o) {
      if (current && current !== o) current.setAttribute('aria-selected', 'false');
      current = o;
      if (!o) { field.removeAttribute('aria-activedescendant'); return; }
      o.setAttribute('aria-selected', 'true');
      field.setAttribute('aria-activedescendant', o.id);
      // In view inside the list only: scrollIntoView would move the page too.
      const top = o.offsetTop, bottom = top + o.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
    // At least the field's width, never wider than the window (min-width beats
    // the width the fit sets).
    const place = () => {
      list.style.minWidth = `${Math.min(field.getBoundingClientRect().width, visible().w - 2 * GAP)}px`;
      fit(list, field);
    };
    const d = {
      btn: field, pop: list,
      isOpen: () => !list.hidden,
      show() {
        for (const o of [...openPops]) if (o !== d) o.hide(false);
        list.hidden = false;
        field.setAttribute('aria-expanded', 'true');
        if (!openPops.includes(d)) openPops.push(d);
        place();
      },
      hide(returnFocus) {
        if (list.hidden) return;
        list.hidden = true;
        field.setAttribute('aria-expanded', 'false');
        activate(null);
        openPops.splice(openPops.indexOf(d), 1);
        if (returnFocus && field.isConnected && document.activeElement !== field) field.focus();
      },
      // Its field scrolled out of view: the list closes rather than float away.
      refit() {
        if (list.hidden) return;
        const a = field.getBoundingClientRect();
        const v = visible();
        if (a.bottom <= v.y || a.top >= v.y + v.h) d.hide(false);
        else place();
      },
    };
    // Every row an option with an id, for aria-activedescendant to name: rows
    // already there when it binds, and each the page adds after.
    function label() {
      for (const o of rows()) {
        if (!o.id) o.id = uid('option');
        o.setAttribute('role', 'option');
        if (o !== current) o.setAttribute('aria-selected', 'false');
      }
    }
    label();
    function update() {
      label();
      const c = choices();
      if (!c.length || document.activeElement !== field) { d.hide(false); return; }
      const keep = c.includes(current);
      if (!keep) list.scrollTop = 0;
      if (d.isOpen()) place(); else d.show();
      activate(keep ? current : autoSelect ? c[0] : null);
    }
    function pick(o) {
      d.hide(false);
      if (document.activeElement !== field) field.focus();
      field.dispatchEvent(new CustomEvent('house:pick', { bubbles: true, detail: { option: o } }));
    }
    // The page refilling the list is what opens, moves and closes it; the
    // list's own hidden and the roles written above are not.
    new MutationObserver(ms => { if (ms.some(m => m.type === 'childList' || m.target !== list)) update(); })
      .observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-disabled'] });
    field.addEventListener('keydown', e => {
      if (composing(e)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const c = choices();
        const down = e.key === 'ArrowDown';
        if (!d.isOpen()) {
          if (!c.length || (field.tagName === 'TEXTAREA' && !e.altKey)) return;
          e.preventDefault();
          d.show();
          activate(down ? c[0] : c[c.length - 1]);
          return;
        }
        e.preventDefault();
        if (!c.length) return;
        const i = c.indexOf(current);
        activate(i < 0 ? c[down ? 0 : c.length - 1] : c[(i + (down ? 1 : -1) + c.length) % c.length]);
      } else if (e.key === 'Enter' && d.isOpen() && current && !(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        pick(current);
      }
    });
    // A press on a choice keeps focus (and the phone's keyboard) in the field.
    const optionOf = e => (e.target instanceof Element ? e.target.closest('.list-option') : null);
    list.addEventListener('mousedown', e => { if (optionOf(e)) e.preventDefault(); });
    list.addEventListener('click', e => {
      const o = optionOf(e);
      if (o && list.contains(o) && choices().includes(o)) pick(o);
    });
    const api = Object.freeze({ update, close: () => d.hide(false), isOpen: d.isOpen, active: () => current });
    typeaheads.set(field, api);
    return api;
  }

  /* ── §7 Archived (N): the one renderer ──────────────────────────────────────
     House.archived(host, { items: [{ id, name, meta }], onRestore })
     draws, inside host, the Archived (N) button (archive icon, then the words;
     hidden when N is 0) and its pop-over of rows: the full name (wrapped, never
     cut) and its meta on the left, a secondary Restore on the right. Restore
     needs no confirmation: it shows "Restoring…", awaits onRestore(item), takes
     the row out and toasts "<name> restored."; if onRestore throws, the button
     comes back and the row says so. Returns { update(items), count }. Call it
     only for a person allowed to restore. */
  function archived(host, { items = [], onRestore, label = 'Archived' } = {}) {
    if (typeof onRestore !== 'function') throw new Error('House.archived: onRestore(item) is required');
    let list = [...items];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn archived-btn';
    const text = document.createElement('span');
    btn.append(icon('archive'), text);
    const pop = document.createElement('div');
    pop.className = 'archived-pop';
    pop.setAttribute('role', 'group');
    pop.setAttribute('aria-label', label);
    host.replaceChildren(btn, pop);
    const d = disclosure(btn, pop, { align: 'start' });

    // Restores in flight and failures, by item id (the item itself when it has
    // none), so a re-render (another restore finishing, update()) keeps a
    // pending row busy and its error showing, and a completion removes ITS item
    // by id, never whatever sits at a stale index.
    const keyOf = item => (item && item.id !== undefined ? item.id : item);
    const indexOf = key => list.findIndex(i => keyOf(i) === key);
    const pending = new Set();
    const failed = new Map();
    const buttons = new Map();

    const row = item => {
      const key = keyOf(item);
      const r = document.createElement('div');
      r.className = 'archived-row';
      const who = document.createElement('div');
      const name = document.createElement('div');
      name.textContent = item.name;
      who.append(name);
      if (item.meta) {
        const meta = document.createElement('div');
        meta.className = 'card-sub';
        meta.textContent = item.meta;
        who.append(meta);
      }
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn-secondary';
      restore.textContent = 'Restore';
      restore.setAttribute('aria-label', `Restore ${item.name}`);
      if (pending.has(key)) busy(restore, 'Restoring…');
      restore.addEventListener('click', async () => {
        if (pending.has(key)) return;
        pending.add(key);
        failed.delete(key);
        message(restore, '');
        busy(restore, 'Restoring…');
        let ok = true;
        try { await onRestore(item); } catch (err) { ok = false; }
        pending.delete(key);
        const active = document.activeElement;
        const hadFocus = pop.contains(active) || !active || active === document.body;
        const at = indexOf(key);
        if (ok) {
          if (at >= 0) list.splice(at, 1);
          toast(`${item.name} restored.`);
        } else if (at >= 0) {
          failed.set(key, `${item.name} could not be restored. Try again.`);
        }
        render();
        if (!hadFocus) return;
        const next = ok
          ? (at >= 0 ? list[Math.min(at, list.length - 1)] : undefined)
          : list[at];
        const target = next !== undefined && buttons.get(keyOf(next));
        if (target && !target.disabled) target.focus();
      });
      r.append(who, restore);
      buttons.set(key, restore);
      return r;
    };
    function render() {
      text.textContent = `${label} (${list.length})`;
      buttons.clear();
      pop.replaceChildren(...list.map(row));
      for (const key of [...failed.keys()]) {
        const b = buttons.get(key);
        if (b) message(b, failed.get(key), { after: b.closest('.archived-row') });
        else failed.delete(key);
      }
      if (!list.length) d.hide(false);
      btn.hidden = list.length === 0;
      d.refit();
    }
    render();
    return {
      update(next) { list = [...next]; render(); },
      get count() { return list.length; },
      button: btn,
      pop,
    };
  }

  /* ── §6 The table comparator: one for every table, blanks last ──────────────
     Numbers (including "1,250" and "12%") compare as numbers, everything else
     as words, case-insensitively and with digits in order ("Item 2" before
     "Item 10"). A blank (empty, null, NaN) sorts last in BOTH directions. */
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const blank = v => v == null || (typeof v === 'number' && Number.isNaN(v)) || (typeof v === 'string' && v.trim() === '');
  const asNumber = v => {
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    const s = String(v).trim().replace(/,/g, '').replace(/%$/, '');
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : null;
  };
  function compare(a, b, dir = 'asc') {
    const ba = blank(a), bb = blank(b);
    if (ba || bb) return ba === bb ? 0 : ba ? 1 : -1;
    const sign = dir === 'desc' ? -1 : 1;
    const na = asNumber(a), nb = asNumber(b);
    if (na !== null && nb !== null) return sign * Math.sign(na - nb);
    return sign * collator.compare(String(a), String(b));
  }

  // §6 Sortable columns: each .th-sort button sorts its column; the <th> carries
  // aria-sort and the button shows " ▲" or " ▼" after a space. A cell's
  // data-sort-value, when present, is what is compared. A table marked
  // data-sort="manual" (paged, or sorted by the server) keeps its rows: the page
  // listens for "house:sort" ({ column, dir }) and re-renders.
  function sortable(table) {
    if (!once(table)) return;
    for (const th of table.querySelectorAll('thead th')) {
      const btn = th.querySelector('.th-sort');
      if (!btn) continue;
      btn.type = 'button';
      let mark = btn.querySelector('.th-sort-dir');
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'th-sort-dir';
        mark.setAttribute('aria-hidden', 'true');
        btn.append(mark);
      }
      const set = th.getAttribute('aria-sort');
      mark.textContent = set === 'ascending' ? ' ▲' : set === 'descending' ? ' ▼' : '';
      btn.addEventListener('click', () => {
        const dir = th.getAttribute('aria-sort') === 'ascending' ? 'desc' : 'asc';
        for (const other of table.querySelectorAll('thead th[aria-sort]')) {
          if (other === th) continue;
          other.removeAttribute('aria-sort');
          const m = other.querySelector('.th-sort-dir');
          if (m) m.textContent = '';
        }
        th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
        mark.textContent = dir === 'asc' ? ' ▲' : ' ▼';
        const column = th.cellIndex;
        if (table.dataset.sort !== 'manual') {
          for (const body of table.tBodies) {
            const rows = [...body.rows];
            if (rows.length < 2) continue;
            const value = r => {
              const c = r.cells[column];
              if (!c) return '';
              return c.dataset.sortValue !== undefined ? c.dataset.sortValue : c.textContent.trim();
            };
            rows.sort((x, y) => compare(value(x), value(y), dir));
            body.append(...rows);
          }
        }
        table.dispatchEvent(new CustomEvent('house:sort', { bubbles: true, detail: { column, dir } }));
      });
    }
  }

  /* ── §11 The segmented control ───────────────────────────────────────────────
     role="tablist" of native <button role="tab">. Tab reaches the selected tab
     only; ← → move to the previous / next tab and select it, wrapping; Home and
     End go to the ends. Each tab's aria-controls panel is shown only while it
     is selected. "house:select" ({ tab }) fires on the tablist on a change. */
  function segmented(list) {
    if (!once(list)) return;
    const tabs = () => [...list.querySelectorAll('[role="tab"]')]
      .filter(t => t.getAttribute('aria-disabled') !== 'true' && !t.disabled);
    const select = (tab, focus) => {
      const changed = tab.getAttribute('aria-selected') !== 'true';
      for (const t of list.querySelectorAll('[role="tab"]')) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls') || '');
        if (panel) panel.hidden = !on;
      }
      if (focus) tab.focus();
      if (changed) list.dispatchEvent(new CustomEvent('house:select', { bubbles: true, detail: { tab } }));
    };
    const all = tabs();
    if (!all.length) return;
    const start = all.find(t => t.getAttribute('aria-selected') === 'true') || all[0];
    start.setAttribute('aria-selected', 'true');
    select(start, false);
    list.addEventListener('click', e => {
      const tab = e.target instanceof Element && e.target.closest('[role="tab"]');
      if (tab && list.contains(tab)) select(tab, false);
    });
    list.addEventListener('keydown', e => {
      const ts = tabs();
      const at = ts.indexOf(document.activeElement);
      if (at < 0) return;
      const rtl = getComputedStyle(list).direction === 'rtl';
      const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
      let to = null;
      if (step) to = ts[(at + step + ts.length) % ts.length];
      else if (e.key === 'Home') to = ts[0];
      else if (e.key === 'End') to = ts[ts.length - 1];
      if (!to) return;
      e.preventDefault();
      select(to, true);
    });
  }

  /* ── §15 The empty state ────────────────────────────────────────────────────
     House.empty(host, { title: 'No items yet.', text, action, small, icon })
     replaces host's content with one .empty-state. action is
     { label: '+ Add item', onClick, primary } for "nothing exists" when the
     viewer can add, or { label: 'Clear search', onClick } for "nothing
     matches". "You cannot see this" has no action. */
  function empty(host, { title, text, action, small = false, icon: iconName } = {}) {
    if (!title) throw new Error('House.empty: title is required ("No things yet.")');
    const box = document.createElement('div');
    box.className = small ? 'empty-state empty-sm' : 'empty-state';
    if (iconName) box.append(icon(iconName));
    const t = document.createElement('div');
    t.className = 'empty-title';
    t.textContent = title;
    box.append(t);
    if (text) {
      const s = document.createElement('p');
      s.className = 'empty-sub';
      s.textContent = text;
      box.append(s);
    }
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = action.primary ? 'btn btn-primary empty-act' : 'btn empty-act';
      b.textContent = action.label;
      if (action.onClick) b.addEventListener('click', action.onClick);
      box.append(b);
    }
    host.replaceChildren(box);
    return box;
  }

  /* ── §10 Dialogs: one focus and closing behaviour for every dialog ──────────
     House.dialog.open(el, { opener, initialFocus }) takes a .dialog-backdrop
     holding a .dialog, or a native <dialog class="dialog"> (opened with
     showModal()), and returns a Promise of the value it closes with
     (undefined when cancelled). It:
       - labels it by its .dialog-title (aria-labelledby; role="dialog" and
         aria-modal="true" on a non-native one);
       - disables the opener while it is open (§9);
       - moves focus in: the first field; else Cancel when the act is red
         (.btn-danger, .btn-delete), so Enter never confirms a delete; else the
         primary button; else the footer's last button;
       - keeps Tab inside it;
       - closes on ×, Cancel (any [data-dialog-close], or the header's
         aria-label="Close"), Esc and a press on the backdrop, except: while
         busy (House.dialog.setBusy) nothing but House.dialog.close closes it,
         and while it holds unsaved typing (any input inside, or
         House.dialog.setDirty) Esc and the backdrop do nothing;
       - Esc closes only the top dialog of a stack. A native <dialog> sits in
         the browser's top layer and makes everything outside it inert, so a
         page's own dialog opened from inside one must be a native <dialog>
         too; confirm / ask / notice always are;
       - closing re-enables the opener and puts focus back on it. */
  const stack = [];
  // The controls Tab stops on, in order: what the browser itself skips is left
  // out, so the trap's first and last are real Tab stops. That is a control
  // disabled directly or by a <fieldset disabled>, one inside [hidden] or
  // [inert], one not rendered or visibility: hidden, and a roving control's
  // tabindex -1 (House.segmented's unselected tabs). A radio group is one stop:
  // its checked radio, else its first. Should a page still hold a stop this
  // misses, the focusin guard below brings focus back.
  const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]';
  function focusables(root) {
    const live = [...root.querySelectorAll(FOCUSABLE)].filter(el => el.tabIndex >= 0
      && !el.matches(':disabled') && !el.closest('[hidden], [inert]')
      && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
    // A group is its name within its owning form (or within no form).
    const groups = new Map();
    const group = el => {
      if (!groups.has(el.form)) groups.set(el.form, new Map());
      return groups.get(el.form);
    };
    for (const el of live) {
      if (el.type !== 'radio' || !el.name) continue;
      const g = group(el), stop = g.get(el.name);
      if (!stop || (el.checked && !stop.checked)) g.set(el.name, el);
    }
    return live.filter(el => el.type !== 'radio' || !el.name || group(el).get(el.name) === el);
  }
  // Whether a node is this dialog's own, by markup: its nearest dialog is this
  // one, not one nested inside it (which may have closed a moment ago).
  const owns = (entry, node) => {
    const n = node instanceof Element && node.closest('dialog, .dialog-backdrop, .dialog');
    return !!n && (n === entry.box || n === entry.backdrop || n === entry.el);
  };
  const entryOf = el => stack.find(e => e.el === el || e.box === el || e.backdrop === el);
  const isClose = el => el instanceof Element
    && (el.closest('[data-dialog-close]') || el.closest('.dialog-header button[aria-label="Close"]'));

  function initialFocusIn(box) {
    const field = focusables(box).find(el => isField(el));
    if (field) return field;
    const footer = box.querySelector('.dialog-footer') || box;
    const buttons = focusables(footer).filter(b => b.tagName === 'BUTTON');
    if (box.querySelector('.btn-danger, .btn-delete')) {
      const cancel = buttons.find(b => !b.matches('.btn-primary, .btn-danger, .btn-delete'));
      if (cancel) return cancel;
    }
    return buttons.find(b => b.matches('.btn-primary'))
      || buttons[buttons.length - 1] || focusables(box)[0] || box;
  }

  // A dialog a page took out of the document while open (no close event comes)
  // is finished before the stack is used, so its opener comes back and Esc and
  // Tab go to a dialog that is there.
  function prune() {
    for (const e of [...stack]) if (!e.box.isConnected) finish(e, undefined);
  }
  function openDialog(el, { opener = document.activeElement, initialFocus } = {}) {
    prune();
    if (entryOf(el)) return entryOf(el).done;
    const native = el.tagName === 'DIALOG';
    const backdrop = native ? null : (el.classList.contains('dialog-backdrop') ? el : el.closest('.dialog-backdrop'));
    const box = native ? el : (backdrop ? backdrop.querySelector('.dialog') || el : el);
    if (!native) {
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
    }
    const title = box.querySelector('.dialog-title');
    if (title && !box.hasAttribute('aria-labelledby')) {
      if (!title.id) title.id = uid('title');
      box.setAttribute('aria-labelledby', title.id);
    }
    const entry = { el, box, backdrop, native, opener: opener instanceof HTMLElement ? opener : null, busy: false, dirty: false };
    entry.done = new Promise(resolve => { entry.resolve = resolve; });
    if (entry.opener && 'disabled' in entry.opener && !entry.opener.disabled && entry.opener !== document.body) {
      entry.opener.disabled = true;
      entry.reenable = true;
    }
    // A dialog answers only for what is its own, not a dialog nested in its
    // markup: an inner Cancel or inner typing never closes or dirties the outer.
    entry.onInput = e => { if (owns(entry, e.target)) entry.dirty = true; };
    entry.onClick = e => {
      if (!owns(entry, e.target)) return;
      if (isClose(e.target)) { request(entry, 'button'); return; }
      const outside = native
        ? e.target === box && !within(box, e)
        : e.target === backdrop;
      if (outside && entry.downOutside) request(entry, 'backdrop');
    };
    // mousedown, not pointerdown: cancelling it keeps focus in the dialog when
    // the press lands on the backdrop (and is then refused, say for typing).
    entry.onDown = e => {
      if (!owns(entry, e.target)) return;
      entry.downOutside = native ? e.target === box && !within(box, e) : e.target === backdrop;
      if (entry.downOutside) e.preventDefault();
    };
    entry.onCancel = e => { e.preventDefault(); request(entry, 'esc'); };
    // A native dialog the browser closed itself (a <form method="dialog">, a
    // page's own dialog.close()) is finished the same way, with its returnValue.
    // The close event is queued, so one from an earlier opening can arrive
    // after the page has opened the dialog again: an open dialog ignores it.
    entry.onClose = () => { if (!box.open) finish(entry, box.returnValue); };
    // ...but not while busy: a <form method="dialog"> submit (its button, or
    // Enter in a field) would close it behind the busy rule's back.
    entry.onSubmit = e => {
      if (entry.busy && e.target.method === 'dialog' && owns(entry, e.target)) e.preventDefault();
    };
    box.addEventListener('input', entry.onInput);
    (backdrop || box).addEventListener('click', entry.onClick);
    (backdrop || box).addEventListener('mousedown', entry.onDown);
    if (native) {
      box.addEventListener('cancel', entry.onCancel);
      box.addEventListener('close', entry.onClose);
      box.addEventListener('submit', entry.onSubmit);
    }
    stack.push(entry);
    if (native) { if (!box.open) box.showModal(); } else (backdrop || box).hidden = false;
    (initialFocus || initialFocusIn(box)).focus();
    return entry.done;
  }
  // A native <dialog>'s backdrop press lands on the dialog element itself.
  function within(box, e) {
    const r = box.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }
  function request(entry, source) {
    if (entry.busy) return;
    if (entry.dirty && (source === 'esc' || source === 'backdrop')) return;
    finish(entry, undefined);
  }
  function finish(entry, value) {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    const { box, backdrop, native } = entry;
    box.removeEventListener('input', entry.onInput);
    (backdrop || box).removeEventListener('click', entry.onClick);
    (backdrop || box).removeEventListener('mousedown', entry.onDown);
    if (native) {
      box.removeEventListener('cancel', entry.onCancel);
      box.removeEventListener('close', entry.onClose);
      box.removeEventListener('submit', entry.onSubmit);
      if (box.open) box.close();
    }
    else (backdrop || box).hidden = true;
    if (entry.reenable) entry.opener.disabled = false;
    if (entry.opener && entry.opener.isConnected) entry.opener.focus();
    entry.resolve(value);
  }
  function closeDialog(el, value) {
    const entry = entryOf(el);
    if (entry) finish(entry, value);
  }
  // keyCode 229 is the composing key event Safari sends after compositionend.
  const composing = e => e.isComposing || e.keyCode === 229;
  const setBusy = (el, on = true) => { const e = entryOf(el); if (e) e.busy = on; };
  const setDirty = (el, on = true) => { const e = entryOf(el); if (e) e.dirty = on; };

  // Esc: an open pop-over first (so a ⋮ inside a dialog closes alone), then the
  // top dialog. Tab: kept inside the top dialog. Window, capture phase, so a
  // native <dialog> never sees an Esc this has already answered.
  let tabBack = false;   // the last Tab's direction, for the focusin backstop below
  // An Esc that cancels an IME composition is the field's, not the dialog's.
  window.addEventListener('keydown', e => {
    if (composing(e)) return;
    prune();
    if (e.key === 'Escape') {
      const pop = openPops[openPops.length - 1];
      if (pop) { e.preventDefault(); pop.hide(true); return; }
      const top = stack[stack.length - 1];
      if (top) { e.preventDefault(); request(top, 'esc'); }
      return;
    }
    if (e.key !== 'Tab') return;
    const top = stack[stack.length - 1];
    if (!top) return;
    const f = focusables(top.box);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    const active = document.activeElement;
    if (!top.box.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    tabBack = e.shiftKey;
  });
  // The backstop: focus that reaches anything outside the top dialog (a Tab
  // stop the list above missed, a page's stray .focus()) is put back inside,
  // at the end it left from.
  document.addEventListener('focusin', e => {
    prune();
    const top = stack[stack.length - 1];
    if (!top || top.box.contains(e.target)) return;
    const f = focusables(top.box);
    const to = f.length ? (tabBack ? f[f.length - 1] : f[0]) : null;
    if (to) to.focus();
  });

  /* ── §9 The shared confirmation dialog: three forms ─────────────────────────
     confirm({ title, body, confirm: 'Archive', kind: 'danger' }) -> true / false
       kind: 'primary' (default), 'danger' (.btn-danger: archive, revoke) or
       'delete' (.btn-delete: Delete permanently, Permanently archive)
     ask({ title, label, value, placeholder, confirm: 'Save', required }) -> text / null
     notice({ title, body }) -> undefined, one Close button
     Each builds the house dialog shell, opens it with House.dialog.open, and
     removes it once answered. */
  // Built as a native <dialog> opened with showModal(), so it joins the top
  // layer: a confirmation asked from inside a page's own native dialog sits
  // above it and stays pressable, where a positioned <div> would be inert
  // beneath it (Codex, #472).
  function shell({ title, body }) {
    const box = document.createElement('dialog');
    box.className = 'dialog';
    const header = document.createElement('div');
    header.className = 'dialog-header';
    const h = document.createElement('h2');
    h.className = 'dialog-title';
    h.textContent = title;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'btn btn-icon';
    x.setAttribute('aria-label', 'Close');
    x.title = 'Close';
    x.dataset.dialogClose = '';
    x.append(icon('x'));
    header.append(h, x);
    const main = document.createElement('div');
    main.className = 'dialog-body';
    if (body) {
      const p = document.createElement('p');
      p.textContent = body;
      main.append(p);
    }
    const footer = document.createElement('div');
    footer.className = 'dialog-footer';
    box.append(header, main, footer);
    document.body.append(box);
    return { box, main, footer };
  }
  const button = (text, cls, close) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    if (close) b.dataset.dialogClose = '';
    return b;
  };
  const need = (opts, keys, fn) => {
    for (const k of keys) if (!opts || !opts[k]) throw new Error(`House.${fn}: ${k} is required (design.md §9)`);
  };

  function confirm(opts) {
    need(opts, ['title', 'confirm'], 'confirm');
    const { title, body, confirm: verb, kind = 'primary', cancel = 'Cancel', opener } = opts;
    const s = shell({ title, body });
    const cls = { primary: 'btn btn-primary', danger: 'btn btn-danger', delete: 'btn btn-delete' }[kind];
    if (!cls) throw new Error(`House.confirm: kind is primary, danger or delete, not "${kind}"`);
    const act = button(verb, cls, false);
    s.footer.append(button(cancel, 'btn btn-secondary', true), act);
    act.addEventListener('click', () => closeDialog(s.box, true));
    return openDialog(s.box, { opener }).then(v => { s.box.remove(); return v === true; });
  }

  function ask(opts) {
    need(opts, ['title', 'label'], 'ask');
    const { title, body, label, value = '', placeholder, confirm: verb = 'Save', cancel = 'Cancel', required = false, type = 'text', opener } = opts;
    const s = shell({ title, body });
    const field = document.createElement('div');
    field.className = 'field';
    const input = document.createElement('input');
    input.className = 'input';
    input.type = type;
    input.id = uid('ask');
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    const l = document.createElement('label');
    l.className = 'label';
    l.htmlFor = input.id;
    l.textContent = label;
    field.append(l, input);
    s.main.append(field);
    const act = button(verb, 'btn btn-primary', false);
    s.footer.append(button(cancel, 'btn btn-secondary', true), act);
    const save = () => {
      if (required && !input.value.trim()) { message(input, `${label} is required.`); input.focus(); return; }
      closeDialog(s.box, input.value);
    };
    act.addEventListener('click', save);
    // Not while an IME is composing: that Enter picks a candidate, not the name.
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !composing(e)) { e.preventDefault(); save(); } });
    const done = openDialog(s.box, { opener });
    // Unsaved typing is a value that differs from the one it opened with.
    s.box.removeEventListener('input', entryOf(s.box).onInput);
    input.addEventListener('input', () => setDirty(s.box, input.value !== value));
    return done.then(v => { s.box.remove(); return typeof v === 'string' ? v : null; });
  }

  function notice(opts) {
    need(opts, ['title'], 'notice');
    const { title, body, close = 'Close', opener } = opts;
    const s = shell({ title, body });
    s.footer.append(button(close, 'btn btn-secondary', true));
    return openDialog(s.box, { opener }).then(() => { s.box.remove(); });
  }

  /* ── Declarative binding ───────────────────────────────────────────────── */
  function init(root = document) {
    for (const el of root.querySelectorAll('[data-icon]')) {
      if (!el.querySelector('svg')) el.append(icon(el.dataset.icon));
    }
    for (const b of root.querySelectorAll('.menu-btn[aria-controls]')) menu(b);
    for (const l of root.querySelectorAll('.segmented[role="tablist"], .segmented [role="tablist"]')) segmented(l);
    for (const t of root.querySelectorAll('table')) if (t.querySelector('thead .th-sort')) sortable(t);
  }

  window.House = Object.freeze({
    init, icon, icons: Object.freeze(Object.keys(ICONS)), message, toast, busy, fit,
    menu, typeahead, archived, compare, sortable, segmented, empty, confirm, ask, notice,
    dialog: Object.freeze({ open: openDialog, close: closeDialog, setBusy, setDirty }),
  });

  // design.md -> Script loading: bind after the DOM, with the readyState fast path.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
})();
