import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const daemonPort = process.env.DAEMON_PORT ?? '4317';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // design/tokens.css and assets/elfoqsy live at the repository root.
    fs: { allow: [repoRoot] },
    // The workspace talks to one origin; Vite forwards the event socket to the daemon.
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${daemonPort}`, ws: true },
      '/attachments': { target: `http://127.0.0.1:${daemonPort}` },
      // Jira attachments of tickets the daemon has read (v1.4).
      '/jira': { target: `http://127.0.0.1:${daemonPort}` },
    },
  },
});
