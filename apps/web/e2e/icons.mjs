// Icons in the page, as the browser tests look at them: where a letter stands in for a logo, a file type, an avatar or a state.
// A placeholder is a small element whose whole content is one to three letters (or a monogram class). The scan reads the page as
// it is drawn, so it sees every tile, chip and badge the screens make, whichever code made them.

/** Small boxes (up to 44 px each way) holding only letters, found in the page as drawn, with where they are and what they are. */
export function scanPlaceholders(page) {
  return page.evaluate(() => {
    const out = [];
    const drawn = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const label = (e) => {
      const classes = [...e.classList].slice(0, 3).join('.');
      return `${e.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
    };
    for (const e of document.querySelectorAll('body *')) {
      if (e.closest('svg, script, style, input, textarea, [contenteditable="true"], .ProseMirror, pre, code')) continue;
      // The element's own text only: a box that holds other boxes is not the placeholder.
      if ([...e.children].some((c) => c.textContent?.trim())) continue;
      const text = (e.textContent ?? '').trim();
      const isLetters = /^[A-Za-z]{1,3}$/.test(text);
      const monogram = /(^|\s)(tile--mono|monogram)(\s|$)/.test(e.className?.toString?.() ?? '');
      if (!isLetters && !monogram) continue;
      const r = e.getBoundingClientRect();
      if (!drawn(e) || r.width > 44 || r.height > 44) continue;
      const s = getComputedStyle(e);
      const boxed = s.backgroundColor !== 'rgba(0, 0, 0, 0)' || Number.parseFloat(s.borderTopWidth) > 0 || Number.parseFloat(s.borderTopLeftRadius) > 0;
      const named = /tile|icon|badge|avatar|initial|glyph|mono|logo/i.test(e.className?.toString?.() ?? '') || /tile|icon|badge|avatar|initial|glyph|mono|logo/i.test(e.parentElement?.className?.toString?.() ?? '');
      if (!boxed && !named && !monogram) continue;
      const cls = `${e.className} ${e.parentElement?.className ?? ''}`;
      const kind = /person|initial|avatar/i.test(cls) ? 'avatar' : /tile|icon|logo|mono|glyph/i.test(cls) ? 'tile' : 'other';
      out.push({ kind, text, element: label(e), parent: e.parentElement ? label(e.parentElement) : '', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  });
}
