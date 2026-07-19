---
name: computer-use
description: >-
  Use the shared Peekaboo MCP to inspect and operate local macOS apps through
  screenshots, accessibility elements, clicks, typing, scrolling, dragging,
  menus, windows, dialogs, and app control. This workflow is shared by Claude,
  Codex, agy, and Grok and does not depend on Orca.
---

# Shared Computer Use

Use the shared `peekaboo` MCP for local macOS desktop interaction. Prefer a
purpose-built connector, API, or CLI when it can complete the task without UI
automation.

## Core workflow

1. Check `permissions` or `list` with `item_type: "server_status"` when the
   runtime is uncertain.
2. Use `list` to identify the target application and window.
3. Use `see` to capture the current UI and obtain opaque element IDs.
4. Prefer accessibility actions such as `click`, `set_value`, and
   `perform_action`; use coordinates only when the accessibility map is
   insufficient.
5. Observe the UI again after every state-changing action. Do not reuse stale
   element IDs after navigation, focus changes, scrolling, or re-rendering.

For websites that do not require the user's existing desktop browser state,
use the `shared-browser` Playwright MCP instead. Use Peekaboo for native apps or
when the task explicitly depends on the user's visible, logged-in browser.

## Safety

- Read only the UI content needed for the request.
- Do not send messages, submit forms, buy items, delete data, change account
  settings, grant permissions, or expose secrets unless the user explicitly
  authorized that action.
- Stop before irreversible or security-sensitive actions that require a fresh
  confirmation.
- If `peekaboo` is unavailable, inspect the shared connector registry and run
  the ChatKJB shared-resource sync. Do not fall back to Orca.
