# Hypernab design system

One set of controls for the app window, the on-page panel and the small extension windows. Source: `public/ds.css` (look) and `public/ds.js` (behaviour). The extension build copies both next to the extension files.

## Rules

1. **No raw browser controls.** No bare `<select>`, checkbox, radio or unstyled `<button>` on screen. Use the parts below.
2. **Light on any PC.** Flat colours only: no blur or `backdrop-filter`, no big shadows (only the small list shadow), no animation, no transition. A test enforces this on `ds.css`.
3. **Theme variables only.** Colours come from the app theme (`theme.css`: dark, light, system, four accents). Fixed colours exist only as `var(--x, #fallback)`. Where there is no `theme.css` (the extension's shadow root and windows) use `HypernabDS.tokens(scheme, accent, selector)`; a test keeps it identical to `theme.css`.
4. **Sizes in `em`**, so each surface scales with its own text size. **Logical properties** (`inset-inline-start`, `padding-inline`) so right-to-left languages mirror.
5. **Keyboard and focus.** Every control is reachable by keyboard and shows the `:focus-visible` ring. Icon-only buttons need an `aria-label`.
6. **Text is set with `textContent`**, never as HTML. User-facing words come from translation keys, not literals in code.
7. **No flags** for languages. A language is not a country. Use the chip with an ISO code.

## Parts

| Part | Use |
|---|---|
| `.hd-btn` (`.primary`, `.quiet`, `.danger`) | Text buttons |
| `.hd-icon-btn` (`.filled`) + `HypernabDS.icon(doc, name)` | Small SVG icon button (`chevron check refresh close download queue sound subtitle globe search`) |
| `.hd-switch`, `.hd-check` (or `HypernabDS.toggle`) | A real `<input type=checkbox>` styled by CSS; keyboard, label click and form state work natively |
| `HypernabDS.select(doc, { options, value, label, onChange, search })` | Drop-down list. Options: `{ value, label, sub?, code?, badge?, disabled? }`. Arrow keys, Home/End, type-ahead, Esc, outside click, flips upward near the window edge, optional search (matches label, sub name and code) |
| `.hd-chip` + `.hd-code` (`HypernabDS.chip`) | Small label with an optional short code (`TR`, `EN`). Tones: `accent`, `warn` |
| `.hd-badge` (`HypernabDS.badge`) | State next to a name ("playing", "site default"). Tone `live` |
| `.hd-dot` (`HypernabDS.dot`) | Status dot. Tones `live`, `warn`, `off` |
| `.hd-input` | Text field |

## Using it

App: add `<link rel="stylesheet" href="/ds.css">` and `<script src="/ds.js"></script>`; `theme.css` already provides the variables.

Page panel (shadow root): put `HypernabDS.tokens('auto', accent)` plus the contents of `ds.css` in the shadow stylesheet, then create controls with the shadow root's document.

Extension window: link `ds.css`, add `<style>` with `HypernabDS.tokens('auto', accent, ':root')` (or its own theme file), load `ds.js`.

## Checking a change

- `node --test test/design-system.test.js` — palette parity, stylesheet hygiene, list keyboard logic.
- `node scripts/visual-matrix.js firefox chrome` — the app window in dark/light, compact/normal, small/large text, and right-to-left: sideways overflow, text contrast, keyboard-only use of the lists, and a scan of every stylesheet for blur, endless animation and big shadows.
- `node scripts/panel-visual.js chrome` — the on-page panel in the real browser (dark, light, accents) with the sound list open; screenshots only.
- `node scripts/language-settings-check.js firefox chrome` — the Settings lists, language choices and the subtitle chips of a job.
- `node scripts/ds-check.js firefox chrome` — draws every part in dark, light, four accents, right-to-left and inside a shadow root, drives the list with real mouse and keyboard, and saves screenshots to look at.
