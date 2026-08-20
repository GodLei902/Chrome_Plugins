# Social Comment Cleaner

Chrome MV3 extension for conservatively cleaning keyword-matched comments from one Instagram post or Reels URL.

## Goals

- Target exactly one configured Instagram `/p/<shortcode>/` or `/reel/<shortcode>/` page
- Preserve whitelist users, including whitelist replies that protect their parent comment
- Match ordinary text keywords case-insensitively; an empty list never deletes
- Use preview and an explicit per-round confirmation before real deletion
- Serialize deletion, enforce delays/limits, and pause when reliable controls cannot be found

## Layout

- `manifest.json` - Chrome extension entry manifest
- `src/background` - service worker and extension-level coordination
- `src/content/rules.js` - independently usable URL, whitelist, keyword and candidate rules
- `src/content/social-comment-cleaner.js` - Instagram page adapter, UI panel and run state
- `src/options` - extension settings UI
- `assets/icons` - extension icons and visual assets

## Use

1. In Chrome, load this folder as an unpacked extension from `chrome://extensions`.
2. Open **Extension options**, enable the extension, supply the exact post URL, whitelist and keywords, then save.
3. Visit that same post while logged in. Start with preview mode, inspect the candidate count, then disable preview mode only after verifying it.

The extension uses the existing Instagram session only; it does not collect credentials or call private APIs. Instagram UI can change, so ambiguous menus, missing confirmation buttons, permissions issues, challenges, and rate-limit messages pause the session rather than clicking a guess.
