import { defineConfig } from 'vitest/config';

// Many tests run real git in temporary folders; a busy disk (a ZFS scrub, a virus scan) can make one take
// longer than vitest's default 5 seconds without anything being wrong.
export default defineConfig({
  test: { testTimeout: 20_000 },
});
