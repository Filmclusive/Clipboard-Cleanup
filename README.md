# Clipboard Cleaner (macOS clipboard sanitizer)

Clipboard Cleaner is a small Tauri + Vite utility that watches the macOS clipboard, applies a configurable sanitization rule set, and rewrites the cleaned text so every paste stays tidy. The UI mimics a background utility (tray menu, floating window) rather than a full application to keep the utility as frictionless as BetterTouchTool-style helpers.

## What it does
- Runs a poll loop and applies rules that collapse inline spacing, blank lines, trailing whitespace, invisible characters, and user-defined phrase stops.
- Skips cleaning while excluded apps are frontmost, and surfaces a colored status dot with the last-cleaned timestamp for visibility.
- Offers a tray menu that lets you toggle the cleaner, reload settings, reopen the floating window, or quit the app.

## Architecture overview
- `src/main.ts` constructs the settings panel, wires the UI controls (rule toggles, save/close buttons, status updates) to the runtime, and orchestrates the tray menu plus poller lifecycle.
- `src/clipboard/*` contains the poller, sanitizer, signature caching, and the low-level string-transformation rules.
- `src/runtime` handles persisted settings (`AppConfig/clipboard-cleaner/settings.json`) and the frontmost-app exclusions used by the poller.
- Styling comes from `src/styles.css`, which already inherits the requested `font-sans` stack (`Verdana`, `Inter`, `sans-serif`) via `:root`, so copy stays consistent across the UI.

## Running & developing
1. `npm install`
2. `npm run dev` to preview the front-end shell.
3. Start Tauri in dev mode with `npm run tauri:dev` (this launches the frameless macOS window and tray icon). You need the Tauri toolchain and Xcode command-line tools installed for this to work.
4. Release-ready builds use `npm run build` followed by `npm run tauri:build --no-bundle`.

## Troubleshooting & known issues
- **Clipboard polling continues even when disabled.** `poller.ts` previously fetched the clipboard before checking `settings.enabled`, so macOS received reads at the configured interval even when the cleaner was off. The guard now runs before `readText()` to stop unnecessary clipboard pressure. (See `src/clipboard/poller.ts` lines 38‑54.)
- **Phrase filters & excluded apps required proper newline splitting.** `splitLines` now splits on `/\r?\n/` so newline-separated filters break into separate entries and the UI uses the same newline when syncing to avoid merging lines. (See `src/main.ts` lines 205‑258.)
- **The default polling interval is aggressive (250 ms) and the loop never backs off.** If users complain about clipboard flicker, consider raising the default or pausing polling when the window is hidden/when the cleaner is disabled.

## Manual verification checklist
1. Toggle each rule, save, and verify `settings.json` in the AppConfig folder updates without errors.
2. Enter multi-line phrase filters/excluded apps after fixing `splitLines` to confirm each entry is honored separately.
3. Disable the cleaner (checkbox or tray toggle) and ensure the colored status dot stops updating and that clipboard reads drop (you can log `readText()` calls to confirm).

## Future work
- Surface `trimWhitespace` in the UI so the user can choose to trim the entire clipboard payload on top of the rule set and verify the new toggle in the Cleaner section.
- Capture more telemetry when the poller writes text (e.g., emit a Tauri event or write to the console) so we can diagnose why the cleaner sometimes does not trigger.
