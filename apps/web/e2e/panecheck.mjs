// What is wrong with a pane in its slot (P1, criterion 5): text scaled, anything clipped, anything overlapping. Run in the page,
// on the box /panes drew. It looks at what a person would: every visible element of the pane, in the slot's own pixels.
//
//  - scaled text: a font size that is not a step of the type scale (text never scales; the slot changes geometry and form only);
//  - clipped: content wider than a box that does not scroll sideways, or taller than a box that hides what overflows;
//    an element sticking out of the slot; text cut by a box it is not allowed to scroll in;
//  - overlapping: two controls, or two pieces of text, whose boxes cross (a control over its own label aside).
export async function checkPane(page, where, selector = '.lab-box') {
  const problems = await page.evaluate((selector) => {
    const out = [];
    const root = document.querySelector(selector);
    const slot = root.getBoundingClientRect();
    const scale = slot.width / root.offsetWidth; // the stage's scale
    const steps = new Set();
    const cs = getComputedStyle(document.documentElement);
    for (const n of ['2xs', 'xs', 'sm', 'md', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl']) steps.add(parseFloat(cs.getPropertyValue(`--font-size-${n}`)));
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const label = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? `.${e.className.trim().split(/\s+/).join('.')}` : ''} "${(e.textContent ?? '').trim().slice(0, 28)}"`;
    // Text kept for screen readers only is clipped by design.
    const all = [...root.querySelectorAll('*')].filter(visible).filter((e) => !e.closest('.visually-hidden') && !e.classList.contains('lab-grip'));
    const scrolls = (e, axis) => {
      const v = getComputedStyle(e)[axis === 'x' ? 'overflowX' : 'overflowY'];
      return v === 'auto' || v === 'scroll';
    };
    const clipsAxis = (e, axis) => {
      const v = getComputedStyle(e)[axis === 'x' ? 'overflowX' : 'overflowY'];
      return v === 'hidden' || v === 'clip';
    };
    // Is the element inside a box that scrolls (so being out of view there is how it works)?
    const inScroll = (e) => {
      for (let p = e.parentElement; p && p !== root; p = p.parentElement) if (scrolls(p, 'y') || scrolls(p, 'x')) return true;
      return false;
    };
    // The canvas and svg draw their own text and geometry; only their boxes count.
    const drawn = (e) => !!e.closest('canvas, svg');
    for (const e of all) {
      const r = e.getBoundingClientRect();
      const text = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      // Text in a size that is not a step of the scale.
      if (text && !drawn(e)) {
        const fs = parseFloat(getComputedStyle(e).fontSize);
        if (!steps.has(fs) && !(getComputedStyle(e).fontSize.endsWith('em'))) {
          // Inline code is 0.85em of its text; allow what is 0.85 of a step.
          const ok = [...steps].some((s) => Math.abs(s * 0.85 - fs) < 0.2);
          if (!ok) out.push(`text ${fs}px is not a step of the type scale: ${label(e)}`);
        }
      }
      // Sticking out of the slot (a scroll box clips what it holds; what is outside the slot is another matter).
      if (!inScroll(e) && !drawn(e) && (r.left < slot.left - 1 || r.top < slot.top - 1 || r.right > slot.right + 1 || r.bottom > slot.bottom + 1)) {
        out.push(`outside the slot: ${label(e)} at ${Math.round((r.left - slot.left) / scale)},${Math.round((r.top - slot.top) / scale)} ${Math.round(r.width / scale)}x${Math.round(r.height / scale)}`);
      }
      // A box that clips sideways or vertically with content beyond it.
      if (!drawn(e)) {
        if (!scrolls(e, 'x') && e.scrollWidth > e.clientWidth + 1 && clipsAxis(e, 'x') && getComputedStyle(e).textOverflow !== 'ellipsis') out.push(`clipped sideways (${e.scrollWidth} > ${e.clientWidth}): ${label(e)}`);
        if (!scrolls(e, 'y') && e.scrollHeight > e.clientHeight + 1 && clipsAxis(e, 'y') && e.tagName !== 'BODY') out.push(`clipped vertically (${e.scrollHeight} > ${e.clientHeight}): ${label(e)}`);
        // Code never wraps, so a code box scrolls sideways; nothing else does.
        if (scrolls(e, 'x') && e.scrollWidth > e.clientWidth + 1 && !e.matches('.diff, .code, pre, code')) out.push(`scrolls sideways: ${label(e)}`);
      }
    }
    // Controls and text that cross each other.
    const parts = all.filter((e) => !drawn(e) && !inScroll(e) && (e.matches('button, input, textarea, a, [role="tab"]') || [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())));
    const box = (e) => e.getBoundingClientRect();
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i];
        const b = parts[j];
        if (a.contains(b) || b.contains(a)) continue;
        // An agent's badge is meant to sit on its ticket's circle.
        const badge = (e) => e.matches('.agent-badge, .ticket-badge');
        if ((badge(a) && b.matches('.ticket-circle, .cmap-dot')) || (badge(b) && a.matches('.ticket-circle, .cmap-dot'))) continue;
        const p = box(a);
        const q = box(b);
        const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (w > 2 && h > 2) out.push(`overlap: ${label(a)} and ${label(b)}`);
      }
    return out.slice(0, 12);
  }, selector);
  return problems.map((p) => `${where}: ${p}`);
}
