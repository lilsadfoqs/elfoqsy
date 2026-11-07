// Instructions for newcomers live behind a small icon: the panel is a tooltip (a floating layer) that shows on hover
// or keyboard focus, beside the icon and on screen, and Escape or a click elsewhere hides it.
import { useId, type ReactNode } from 'react';
import { Floating, refTo, useLayer } from './layers';

export function Hint({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  const id = useId();
  const tip = useLayer('tooltip');
  return (
    <span className="hint" onMouseLeave={() => tip.hide()}>
      <button
        ref={refTo(tip.anchor)}
        type="button"
        className="hint-button"
        aria-label={label}
        {...(tip.open ? { 'aria-describedby': id } : {})}
        onMouseEnter={tip.show}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && tip.show()}
        onBlur={() => tip.hide()}
      >
        {icon}
      </button>
      <Floating layer={tip} side="bottom" align="start" gap={8} className="hint-panel" role="tooltip" id={id}>
        {children}
      </Floating>
    </span>
  );
}

/** Keys as key caps, then what they do. */
export function KeyRow({ keys, children }: { keys: string[] | string; children: ReactNode }) {
  return (
    <>
      <span className="key-caps">
        {typeof keys === 'string' ? <span className="key-caps-words">{keys}</span> : keys.map((k) => <kbd key={k}>{k}</kbd>)}
      </span>
      <span className="key-does">{children}</span>
    </>
  );
}
