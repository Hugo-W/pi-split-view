# Changelog

Notable changes to `pi-split-view`. Versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Zooming the Tool Usage panel (`[↗]`) now shows full detail for every tool: its whole
  stored output (up to 20 lines) instead of the 2-line preview, whatever the
  `/split-tools-view` mode.
- Tool results that contain images (e.g. `read` on an image file) render inline in the
  Tool Usage panel in full detail and zoomed views, using pi-tui's `Image` component like
  pi's transcript does (Kitty/iTerm2). Other terminals show pi's text fallback.

## [1.2.0] — 2026-10-21

### Added

- Mouse: `[↗]`/`[↙]` header buttons expand a panel over the area above the editor
  (and restore it), `[×]` hides it; drag the band's bottom border to resize its
  height, the Tool Usage panel's left edge for the thinking ↔ tools split, and the
  files dock's left edge for its width (`filesWidth` in the config, saved by
  `/split-save`). Mouse wheel over a panel's frame now scrolls that panel.
- Tool durations in the Tool Usage panel, with a live elapsed counter while a call runs.
- The band hides itself when the terminal is too short to fit it above the transcript.
- `npm test`: unit tests for the pure helpers (moved to `helpers.ts`).

### Changed

- Thinking panel: wrapped rows are memoized per line (only the streaming tail
  re-wraps on a flush), the scrollback window grows from 96 to 400 rows, and flushes
  run every 50 ms instead of 100 ms.
- Resizing the terminal re-applies panel widths in place instead of rebuilding the
  layout, so panel scroll positions survive.

### Fixed

- Response-only mode: the response view is now pi's primary scroll view, so
  PgUp/PgDn, pi's Ctrl+F search and the jump-to-end indicator act on it. They used to
  act on the Thinking panel.
- Thinking panel: long paragraphs without line breaks were cut to their last 600
  characters and re-flowed on every streaming flush, which made the text jump around.
  They are now kept whole (up to 16K characters) and re-flow at most once per ~8K.
- Thinking panel: a streamed chunk over 2,000 characters could drop complete lines
  before they were split out.

## [1.1.0] — 2026-10-16

### Added

- `/split-diff` — toggle the files dock's edit-diff subpanel independently, keeping just
  the touched-files list.
- A dim dashed rule between **successive assistant answers** in response-only mode
  (`/split-trim-response`). It never appears around user messages, and can be switched
  back to plain blank-line spacing with `/split-divider space` or the `answerDivider`
  config key (`"rule"` | `"space"`, default `"rule"`).
- `tsconfig.json` and `npm run typecheck` (`tsc --noEmit`).

### Changed

- `peerDependencies` floored to `>=1.2.0` (was `*`) so API drift is visible.
- Files-dock width computation deduplicated onto one helper.

### Fixed

- `/split-save` now uses a valid notification severity (previously an unsupported
  `"success"`, which pi silently downgraded to a neutral status).
- The `setWidget` factory returns a conformant `Component` (`invalidate()`) and uses the
  theme passed by pi instead of reading a non-existent `tui.theme`.
- The `tool_result` edit-path value is guarded to a string (`{}` → `string` type error).

## [1.0.x] and earlier

See the git history for releases before 1.1.0.
