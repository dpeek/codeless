# Codeless

Codeless is an attended planner and implementer workflow for parallel capability
development. Bun is the runtime. Git, Herdr, and Pi are external runtime
dependencies.

## Rules

1. Optimize for the current product, not historical compatibility.
   - Breaking changes are acceptable by default.
   - Do not add shims, deprecated command aliases, or compatibility tests unless
     explicitly required.
   - Replace obsolete paths and remove their code, tests, and documentation.
2. Ship the smallest complete capability.
   - Keep the approval boundary, one-change-per-stream invariant, landing lock,
     and deliberate recovery behavior explicit.
   - Test observable behavior at the highest stable boundary that remains fast
     and deterministic.
   - Keep integration tests self-contained; never launch real agents from tests.
3. Give each invariant and piece of state one owner.
   - Codeless owns reusable execution mechanics and local workflow state.
   - Consuming projects own directions, prompts, model choices, and policy.
   - Pi and Herdr own their runtime APIs and process behavior.
4. Prefer simple Bun automation and Effect patterns.
   - After `bun install`, read `node_modules/effect/AGENTS.md` before changing
     Effect code.
   - Inspect installed Pi and Herdr versions before relying on new runtime APIs.

## Documentation

- `README.md` owns installation, configuration, commands, and recovery guidance.
- `.codeless/` owns this project's workflow configuration and prompts;
  `.codeless/state/` is ignored local workflow state.
- `spec/workflow.md` owns implemented behavior and invariants.
- `todo/workflow.md` owns proposed or missing behavior.

Each implementation change updates code, focused tests, the affected contract,
and the todo together. Remove satisfied intentions from the todo rather than
retaining a current-state recap.
