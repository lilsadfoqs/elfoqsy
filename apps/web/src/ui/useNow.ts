import { useEffect, useState } from 'react';
import { stream } from '../state/workspace';

/** The daemon's clock, ticking every `ms`: for what changes with time alone (the clock, "just finished"). */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => stream.now());
  useEffect(() => {
    const id = setInterval(() => setNow(stream.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
