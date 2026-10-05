import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Three suites drive real git and the built CLI as subprocesses. Idle they finish well under
    // two seconds, but on a contended machine — a CI runner, or a laptop building something else —
    // they have overrun the 5s default and failed as timeouts, which reads exactly like a broken
    // change. Set globally rather than per file: the risk follows any test that spawns a process,
    // not any particular suite, and a local override is one a future subprocess test would silently
    // miss. A timeout only bounds a hang, so a generous one costs a passing run nothing.
    // Second occurrence, 2026-10: the fleet sweep tests grew with the pack work (the pinned
    // no-.etymd sweep idles around 7.5s) and blew 20s on a contended machine running the whole
    // suite in parallel — green isolated, red loaded. Same remedy, same reason: 60s.
    testTimeout: 60_000,
  },
})
