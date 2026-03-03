# Desktop Runtime Lifecycle Diagrams

This page is the entrypoint for desktop lifecycle diagrams.

The previous all-in-one sequence was split into focused diagrams so each one answers one question.

## Diagram Set

1. [00-desktop-components.md](./00-desktop-components.md)
    - Static high-level composition and boundaries.
2. [01-desktop-startup-happy-path.md](./01-desktop-startup-happy-path.md)
    - Boot sequence until runtime is ready.
3. [02-desktop-failure-and-restart-loop.md](./02-desktop-failure-and-restart-loop.md)
    - Fail-fast restart behavior on startup/runtime failures.
4. [03-desktop-window-tray-operations.md](./03-desktop-window-tray-operations.md)
    - Close/hide behavior, tray actions, and graceful shutdown.
5. [04-desktop-userland-request-path.md](./04-desktop-userland-request-path.md)
    - Browser userland page + API flow.
6. [05-desktop-timing-controls.md](./05-desktop-timing-controls.md)
    - Timing constants and their role.

## Runtime Context

- `src-tauri/*` runs in the native Rust desktop process.
- Admin UI runs in the Tauri WebView and calls Tauri commands.
- Userland UI runs in the system browser against localhost backend.
- Backend and indexer workers are separate Node child processes managed by the Rust supervisor.
