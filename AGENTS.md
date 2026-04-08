## Clipboard Cleaner Agent Notes

### Purpose
This repository delivers the Clipboard Cleaner utility: a Tauri + Vite tray app that sanitizes macOS clipboard text, enables/disables itself from a floating window, and lets you configure rules, phrase filters, and excluded frontmost apps.

### Key files
- `src/main.ts`: builds the frameless settings panel, attaches controls (checkboxes, textarea), manages persistence (`persistSettings`), and manages tray menu actions plus poller lifecycle.
- `src/clipboard`: Poller logic, sanitization rules, and signature cache that prevent redundant writes.
- `src/runtime`: Settings persistence (`BaseDirectory.AppConfig/clipboard-cleaner/settings.json`) and frontmost-app exclusions.
- `src/styles.css`: Global typography adheres to `font-sans`, so keep UI copy inheriting Verdana/Inter.

### Current priorities
1. Improve reliability: the cleaner should not read the clipboard or write sanitized text when disabled, and phrase filters/excluded apps must split cleanly on user-entered newlines so each entry is honored.
2. Keep the Cleaner section informative: surface the `trimWhitespace` toggle, keep the helper text for the polling interval, and ensure the floating window only allows dragging from the header.
3. Stabilize UX: the frameless window can only be dragged via the header—avoid placing interactive controls inside that drag region.

### Performance/UX notes
- Clipboard polling defaults to 250 ms and recurses via `setTimeout`. Consider raising the default interval or pausing when the cleaner is off to reduce CPU and clipboard access.
- The tray menu is the primary entry point; the floating window should close/hide instead of quitting so the cleaner keeps running in the background.
- Keep fonts readable (no uppercase/wide tracking) and rely on root `font-sans` inheritance.

### Testing
- Run `npm run dev` + `npm run tauri:dev` while iterating UI changes.
- Validate saves by checking `~Library/Application Support/clipboard-cleaner/settings.json`.
- To test rules quickly, copy text with trailing spaces, blank lines, or zero-width characters and confirm the cleaner rewrites them only when enabled.
