/* Hypernab design system, script part (see ds.css and docs/design-system.md). A classic script that works in the app, in the extension's
   page panel (inside a shadow root) and in the extension windows: it only needs the DOM and sets globalThis.HypernabDS.
   Text is always set with textContent, never as HTML. */
(function () {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';

  const ICONS = {
    chevron: 'M6 9l6 6 6-6',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4.5V11h-6.5',
    close: 'M6 6l12 12M18 6L6 18',
    download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
    queue: 'M4 7h12M4 12h12M4 17h8M19 14v6M16 17h6',
    sound: 'M4 10v4h3.5l4.5 3.5v-11L7.5 10H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
    subtitle: 'M4 6h16v12H4zM7 11h4M13 11h4M7 14.5h6',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20',
  };

  /** A line icon. `name` is one of ICONS; the shape is drawn in a 24x24 box and coloured by the text colour. */
  function icon(doc, name) {
    const svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'hd-ic'); svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(SVG, 'path'); path.setAttribute('d', ICONS[name] || ICONS.check);
    svg.append(path);
    return svg;
  }

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A chip: optional short code in front (TR, EN...), a name and optionally a quieter second name. */
  function chip(doc, { code, text, sub, tone } = {}) {
    const node = el(doc, 'span', 'hd-chip');
    if (tone) node.setAttribute('data-tone', tone);
    if (code) node.append(el(doc, 'span', 'hd-code', code));
    if (text) node.append(el(doc, 'span', 'hd-chip-text', text));
    if (sub) node.append(el(doc, 'span', 'hd-chip-sub', sub));
    return node;
  }
  function badge(doc, text, tone) { const node = el(doc, 'span', 'hd-badge', text); if (tone) node.setAttribute('data-tone', tone); return node; }
  function dot(doc, tone) { const node = el(doc, 'span', 'hd-dot'); if (tone) node.setAttribute('data-tone', tone); node.setAttribute('aria-hidden', 'true'); return node; }

  /** A switch or checkbox with its label. `kind`: 'switch' (default) or 'check'. */
  function toggle(doc, { text, checked = false, kind = 'switch', onChange, id } = {}) {
    const label = el(doc, 'label', 'hd-toggle');
    const input = el(doc, 'input', kind === 'check' ? 'hd-check' : 'hd-switch');
    input.type = 'checkbox'; input.checked = Boolean(checked);
    if (kind !== 'check') input.setAttribute('role', 'switch');
    if (id) input.id = id;
    if (onChange) input.addEventListener('change', () => onChange(input.checked));
    label.append(input);
    if (text) label.append(el(doc, 'span', 'hd-toggle-text', text));
    return { el: label, input };
  }

  // ---- Keyboard logic of the list, kept pure so it can be tested without a browser. -----------------------------------------------------
  /** Next enabled index when moving by `step` (1 or -1) from `from`; stays put when nothing else is enabled. Does not wrap. */
  function moveIndex(options, from, step) {
    for (let i = from + step; i >= 0 && i < options.length; i += step) if (!options[i].disabled) return i;
    return from;
  }
  function edgeIndex(options, last) {
    const order = options.map((_, i) => i); if (last) order.reverse();
    return order.find(i => !options[i].disabled) ?? -1;
  }
  /** Type-ahead: the next enabled option (after `from`) whose label starts with the typed text, or -1. */
  function typeahead(options, from, typed) {
    const text = typed.toLocaleLowerCase();
    if (!text) return -1;
    const labels = options.map(o => String(o.label ?? '').toLocaleLowerCase());
    const start = typed.length === 1 ? from + 1 : from; // the same letter again cycles through the matches
    for (let n = 0; n < options.length; n++) {
      const i = (start + n + options.length) % options.length;
      if (!options[i].disabled && labels[i].startsWith(text)) return i;
    }
    return -1;
  }
  /** One key press on an open or closed list: what happens next. Returns { open, index, commit }. */
  function listKey(state, key, options) {
    const { open, index } = state;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!open) return { open: true, index: index >= 0 ? index : edgeIndex(options, false), commit: false };
      return { open, index: index < 0 ? edgeIndex(options, key === 'ArrowUp') : moveIndex(options, index, key === 'ArrowDown' ? 1 : -1), commit: false };
    }
    if (key === 'Home' || key === 'End') return open ? { open, index: edgeIndex(options, key === 'End'), commit: false } : { open, index, commit: false };
    if (key === 'Enter' || key === ' ') return open ? { open: false, index, commit: index >= 0 } : { open: true, index: index >= 0 ? index : edgeIndex(options, false), commit: false };
    if (key === 'Escape') return { open: false, index, commit: false };
    if (key === 'Tab') return { open: false, index, commit: open && index >= 0 };
    return { open, index, commit: false };
  }

  /**
   * A select. options: [{ value, label, sub?, code?, badge?: { text, tone }, disabled? }]. `render(option)` may return a node to
   * replace the default row content. Returns { el, setValue, getValue, setOptions, setDisabled, close }.
   */
  function select(doc, { options = [], value, label, placeholder = '', onChange, search = false, searchLabel = '', emptyText = '', render, id } = {}) {
    const win = doc.defaultView || globalThis;
    let list = options.slice(), current = value, open = false, active = -1, typed = '', typedAt = 0, query = '';
    const uid = `hd-${Math.random().toString(36).slice(2, 8)}`;
    const root = el(doc, 'div', 'hd-select');
    const button = el(doc, 'button', 'hd-select-btn');
    button.type = 'button'; button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    if (label) button.setAttribute('aria-label', label);
    if (id) button.id = id;
    const shown = el(doc, 'span', 'hd-select-value');
    button.append(shown, icon(doc, 'chevron'));
    const pop = el(doc, 'div', 'hd-pop'); pop.hidden = true;
    const box = el(doc, 'div'); box.setAttribute('role', 'listbox'); if (label) box.setAttribute('aria-label', label); box.id = `${uid}-list`;
    let field = null;
    if (search) {
      field = el(doc, 'input', 'hd-input hd-pop-search'); field.type = 'search'; field.setAttribute('aria-label', searchLabel || label || '');
      pop.append(field);
    }
    pop.append(box);
    root.append(button, pop);

    const content = option => render?.(option) ?? (() => {
      const frag = el(doc, 'span', 'hd-select-value');
      if (option.code) frag.append(el(doc, 'span', 'hd-code', option.code));
      frag.append(el(doc, 'span', 'hd-label', option.label));
      return frag;
    })();
    const visible = () => query ? list.filter(o => `${o.label} ${o.sub || ''} ${o.code || ''}`.toLocaleLowerCase().includes(query)) : list;

    const paintValue = () => {
      shown.replaceChildren();
      const option = list.find(o => o.value === current);
      if (option) shown.append(content(option));
      else shown.append(el(doc, 'span', 'hd-label', placeholder));
    };
    const paintList = () => {
      box.replaceChildren();
      const rows = visible();
      if (!rows.length && emptyText) box.append(el(doc, 'div', 'hd-empty', emptyText));
      rows.forEach((option, i) => {
        const row = el(doc, 'div', 'hd-opt'); row.id = `${uid}-${i}`; row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', option.value === current ? 'true' : 'false');
        if (option.disabled) row.setAttribute('aria-disabled', 'true');
        if (i === active) row.classList.add('active');
        const copy = el(doc, 'span', 'hd-opt-copy');
        if (option.code) { const line = el(doc, 'span', 'hd-select-value'); line.append(el(doc, 'span', 'hd-code', option.code), el(doc, 'span', 'hd-label', option.label)); copy.append(line); }
        else copy.append(el(doc, 'span', 'hd-label', option.label));
        if (option.sub) copy.append(el(doc, 'span', 'hd-sub', option.sub));
        row.append(copy);
        if (option.badge) row.append(badge(doc, option.badge.text, option.badge.tone));
        const tick = icon(doc, 'check'); tick.setAttribute('class', 'hd-ic hd-tick'); row.append(tick);
        row.addEventListener('pointerdown', event => event.preventDefault()); // keep focus where it is
        row.addEventListener('click', () => { if (!option.disabled) choose(option); });
        row.addEventListener('pointermove', () => { if (active !== i && !option.disabled) { active = i; mark(); } });
        box.append(row);
      });
      mark();
    };
    const mark = () => {
      [...box.children].forEach((row, i) => { if (i === active) row.classList.add('active'); else row.classList.remove('active'); });
      const row = box.children[active];
      if (open && row) { button.setAttribute('aria-activedescendant', row.id); row.scrollIntoView?.({ block: 'nearest' }); }
      else button.removeAttribute?.('aria-activedescendant');
    };
    function place() {
      pop.classList.remove('up');
      const rect = button.getBoundingClientRect?.(), height = win.innerHeight || 0;
      if (!rect || !height) return;
      const need = Math.min(pop.offsetHeight || 0, 256);
      if (rect.bottom + need + 8 > height && rect.top > height - rect.bottom) pop.classList.add('up');
    }
    function setOpen(next) {
      if (next === open) return;
      open = next; root.setAttribute('data-open', String(open)); button.setAttribute('aria-expanded', String(open)); pop.hidden = !open;
      if (open) {
        query = ''; if (field) field.value = '';
        active = visible().findIndex(o => o.value === current); if (active < 0) active = edgeIndex(visible(), false);
        paintList(); place();
        doc.addEventListener?.('pointerdown', outside, true);
        if (field) field.focus?.();
      } else { doc.removeEventListener?.('pointerdown', outside, true); button.removeAttribute?.('aria-activedescendant'); }
    }
    function outside(event) { if (!(event.composedPath?.() || []).includes(root)) setOpen(false); }
    function choose(option) {
      const changed = option.value !== current;
      current = option.value; paintValue(); setOpen(false); button.focus?.();
      if (changed) onChange?.(current, option);
    }
    function key(event) {
      const rows = visible();
      if (open && field && event.target === field && !['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab', 'Home', 'End'].includes(event.key)) return; // typing in the search box
      if (event.key.length === 1 && event.key !== ' ' && !field && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now(); typed = now - typedAt > 700 ? event.key : typed + event.key; typedAt = now;
        const hit = typeahead(rows, active, typed);
        if (hit >= 0) { if (!open) setOpen(true); active = hit; mark(); }
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'].includes(event.key)) return;
      if (event.key === 'Escape' && !open) return;
      const next = listKey({ open, index: active }, event.key, rows);
      if (event.key !== 'Tab') { event.preventDefault(); event.stopPropagation(); }
      active = next.index;
      if (next.commit && rows[active]) { choose(rows[active]); return; }
      if (next.open !== open) setOpen(next.open); else mark();
      if (event.key === 'Escape') button.focus?.();
    }
    button.addEventListener('click', () => setOpen(!open));
    button.addEventListener('keydown', key);
    if (field) {
      field.addEventListener('keydown', key);
      field.addEventListener('input', () => { query = field.value.trim().toLocaleLowerCase(); active = visible().findIndex(o => !o.disabled); paintList(); });
    }
    paintValue();
    return {
      el: root, button,
      getValue: () => current,
      setValue(next) { current = next; paintValue(); if (open) paintList(); },
      setOptions(next, nextValue = current) { list = next.slice(); current = nextValue; paintValue(); if (open) paintList(); },
      setDisabled(flag) { button.disabled = Boolean(flag); if (flag) setOpen(false); },
      close: () => setOpen(false),
    };
  }

  // ---- Theme tokens for places that have no theme.css (the extension's shadow root and windows). Kept equal to theme.css by a test. ----------
  const DARK = { '--bg': '#0e1113', '--panel': '#171c1f', '--raised': '#20272b', '--border': '#2b3439', '--text': '#edf2ee', '--muted': '#93a19f', '--danger': '#f29b91',
    '--accent-ink': '#142010', '--hover': '#2a3530', '--hover-2': '#2c373c', '--border-strong': '#46534e', '--faint': '#758581', '--field': '#101618', '--warn-text': '#e8b48c',
    '--warn-bg': '#2e2a1d', '--danger-bg': '#392622', '--ok-text': '#a5c792', '--chip': '#26302d', '--track': '#2b3730', '--switch-off': '#3b4744', '--switch-knob': '#d0dad5' };
  const LIGHT = { '--bg': '#f3f5f4', '--panel': '#ffffff', '--raised': '#eef1ef', '--border': '#d8dedb', '--text': '#18201c', '--muted': '#5b6862', '--danger': '#b3382b',
    '--accent-ink': '#ffffff', '--hover': '#e5eae7', '--hover-2': '#dfe5e2', '--border-strong': '#bdc7c2', '--faint': '#7b8882', '--field': '#ffffff', '--warn-text': '#8f5412',
    '--warn-bg': '#fbf1da', '--danger-bg': '#fde8e5', '--ok-text': '#2d6a38', '--chip': '#e6ebe8', '--track': '#dce3df', '--switch-off': '#c2cbc6', '--switch-knob': '#ffffff' };
  const ACCENTS = { dark: { green: '#b6f36b', blue: '#6cb4ff', orange: '#ffb257', violet: '#b69cff' }, light: { green: '#2d7d34', blue: '#1f6fd1', orange: '#bd5b00', violet: '#6a45d1' } };
  const DERIVED = '--accent-soft:color-mix(in srgb,var(--accent) 16%,var(--panel));--accent-line:color-mix(in srgb,var(--accent) 45%,var(--border));--accent-hover:color-mix(in srgb,var(--accent) 85%,var(--text));';
  const block = (selector, scheme, accent) => {
    const base = scheme === 'light' ? LIGHT : DARK;
    const accents = ACCENTS[scheme];
    return `${selector}{color-scheme:${scheme};${Object.entries(base).map(([k, v]) => `${k}:${v}`).join(';')};--accent:${accents[accent] || accents.green};${DERIVED}}`;
  };
  /** CSS text that defines the theme variables on `selector` (default ':host'). scheme: 'dark' | 'light' | 'auto' (follows the system). */
  function tokens(scheme = 'auto', accent = 'green', selector = ':host') {
    if (scheme === 'light') return block(selector, 'light', accent);
    if (scheme === 'auto') return `${block(selector, 'dark', accent)}@media (prefers-color-scheme:light){${block(selector, 'light', accent)}}`;
    return block(selector, 'dark', accent);
  }

  // ---- Languages. No flags: a language is not a country. A language is shown by its ISO code and its name in the interface language,
  // with its own name quieter beside it (so a speaker of any language can find theirs). Names come from the platform (Intl.DisplayNames).
  const LANGUAGE_CODES = 'ar az bg bn bs ca cs da de el en es et fa fi fr gu he hi hr hu hy id it ja ka kk km ko lt lv mk ml mr ms my nb nl pa pl pt ro ru si sk sl sq sr sv sw ta te th tr uk ur uz vi zh'.split(' ');
  function languageName(code, locale) {
    try { return new Intl.DisplayNames([locale || 'en'], { type: 'language' }).of(code) || code; } catch { return code; }
  }
  const capital = (text, locale) => text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;
  /** { code: 'TR', name: 'Turkish', own: 'Türkçe' } for the interface language `locale`; `own` is empty when it equals `name`. */
  function languageInfo(code, locale) {
    const name = capital(languageName(code, locale), locale), own = capital(languageName(code, code), code);
    return { code: String(code).toUpperCase(), name, own: own === name ? '' : own };
  }
  /** Select options for languages, sorted by the name in the interface language. `first` are fixed options placed before the list. */
  function languageOptions(codes, locale, first = []) {
    const list = codes.map(code => { const info = languageInfo(code, locale); return { value: code, code: info.code, label: info.name, sub: info.own }; });
    list.sort((a, b) => a.label.localeCompare(b.label, locale || 'en'));
    return [...first, ...list];
  }
  function languageChip(doc, code, locale, { tone, own = false } = {}) {
    const info = languageInfo(code, locale);
    return chip(doc, { code: info.code, text: info.name, sub: own ? info.own : '', tone });
  }

  globalThis.HypernabDS = { languageInfo, languageOptions, languageChip, LANGUAGE_CODES, icon, ICONS, chip, badge, dot, toggle, select, tokens, listKey, moveIndex, typeahead, tables: { DARK, LIGHT, ACCENTS } };
})();
