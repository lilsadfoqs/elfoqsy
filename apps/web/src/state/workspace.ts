// The workspace's single event stream, and the hook screens read it through.
import { useSyncExternalStore } from 'react';
import { EventStream, type Snapshot } from './stream';

export const stream = new EventStream(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, undefined, {
  tester: new URLSearchParams(location.search).has('tester'),
});

export function useWorkspace(): Snapshot {
  return useSyncExternalStore(stream.subscribe, stream.getSnapshot);
}
