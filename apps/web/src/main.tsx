import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LeftScreen } from './left/LeftScreen';
import { Lab } from './panes/Lab';
import { connectRelay } from './panes/relay';
import { RightScreen } from './right/RightScreen';
import { stream } from './state/workspace';
import './styles.css';

// Two routes, one per monitor. Anything else goes to /left. /panes is the size lab: one pane in a box of a size, for checking its forms.
if (location.pathname !== '/left' && location.pathname !== '/right' && location.pathname !== '/panes') history.replaceState(null, '', '/left');
const Screen = location.pathname === '/right' ? RightScreen : location.pathname === '/panes' ? Lab : LeftScreen;

connectRelay(stream);
stream.start();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Screen />
  </StrictMode>,
);
