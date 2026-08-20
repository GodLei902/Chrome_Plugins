# Social Comment Cleaner

Project scaffold for a Chrome extension that targets social platform comment cleanup.

## Goals

- Target a specific platform post
- Filter comments with a whitelist
- Remove nested comments under first-level comments
- Start with Instagram support and keep the structure ready for TikTok, YouTube, Facebook, and other platforms

## Layout

- `manifest.json` - Chrome extension entry manifest
- `src/background` - service worker and extension-level coordination
- `src/content` - platform page automation logic
- `src/options` - extension settings UI
- `assets/icons` - extension icons and visual assets

## Current state

This is the initial directory and file scaffold only. Platform implementations will be added next.
