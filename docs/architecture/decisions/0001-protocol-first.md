# Decision 0001: protocol-first portability

Status: accepted

## Decision

tiacore defines portable behavior through a versioned protocol, deterministic
planning rules, and language-independent conformance vectors. It does not
require every SDK to call one shared native executable.

The existing TypeScript implementation remains the JavaScript SDK. A future
SDK may implement the planner in its own language when it produces the same
plans for the conformance vectors.

## Why

The JavaScript adapters already integrate directly with Vitest, Playwright,
Node, Bun, Istanbul, and Vite. Replacing their planner with a native binary or
WASM module would add packaging and debugging costs before another language
has demonstrated a need for it.

A protocol-first design lets the first non-JavaScript adapter prove the actual
integration boundary. If maintaining two conforming planners later costs more
than distributing one shared implementation, tiacore can adopt a native or
WASM core with evidence from that adapter.

## Consequences

- Protocol changes require schemas, compatibility rules, and conformance
  vectors.
- JavaScript-only coverage data and runner metadata stay outside the portable
  graph.
- A language SDK may not claim compatibility from type similarity alone. It
  must pass the conformance kit.
- `@usescherie/tiacore` remains one root npm package while exact VCS installs
  are in active use.
