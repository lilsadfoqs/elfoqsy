// A fixed 1920×1080 stage, scaled to fit the window and centred. Screens never scroll.
// While the daemon is unreachable the whole stage dims, quietly; it shows the last known state.
import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';
import { DataTips, LayerRoot } from '../ui/layers';

export const STAGE = { width: 1920, height: 1080 } as const;

const fit = (): number => Math.min(window.innerWidth / STAGE.width, window.innerHeight / STAGE.height);

export function Stage({ label, offline, children, handlers }: { label: string; offline: boolean; children: ReactNode; /** Pointer and drag handlers for the whole screen (P2: where a pane is dropped). */ handlers?: HTMLAttributes<HTMLElement> }) {
  const [scale, setScale] = useState(fit);
  // Floating layers are drawn here, over the screen and outside its clipping, in one stacking order.
  const [layers, setLayers] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const onResize = () => setScale(fit());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return (
    <div className="viewport">
      <main
        className={offline ? 'stage stage--offline' : 'stage'}
        aria-label={label}
        style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
        {...handlers}
      >
        <LayerRoot.Provider value={layers}>
          {children}
          <DataTips />
        </LayerRoot.Provider>
        <div className="layer-root" ref={setLayers} />
      </main>
    </div>
  );
}
