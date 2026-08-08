import { defineConfig } from 'vitest/config';

// The engine fixtures shell out to real git and run a repro three times, so the
// slowest tests sit near vitest's 5s default and fail under load. Raise the
// ceiling rather than let a green suite depend on how busy the machine is.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
