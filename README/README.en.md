# Dreamisle

Dreamisle (音梦屿) is a local music player built with Electron for Windows 10/11.

[中文](../README.md) | English

![App Screenshot](../img/img1.png)

## Features

- **Local library**: Recursively scans folders; supports MP3, FLAC, WAV, OGG, and M4A; reads title, artist, album, bitrate, sample rate, bit depth, and embedded cover art with `music-metadata`.
- **Playback**: List loop, single loop, and shuffle; persists library paths, progress, volume, and play mode.
- **Lyrics**: Prefers an adjacent `.lrc` file, then embedded lyrics; parses same-timestamp bilingual pairs, brackets, vertical bars, tabs, and thin spaces; supports `[offset:]`, a translation toggle, click-to-seek, and horizontal scrolling for overlong lines.
- **Desktop lyrics**: Always-on-top overlay; adjustable background/text opacity, text color, and font; optional click-through; toggle with `Ctrl+Alt+L`.
- **Taskbar lyrics (Windows 10/11)**: Shows cover art and two lyric lines in the taskbar's free space, avoiding app buttons and the notification area; a fixed width prevents taskbar icons from shifting between lines; separate font, weight, and color settings; toggle with `Ctrl+Alt+T` or the tray menu.
- **Mini mode**: `F5` switches to a 300×340 always-on-top window with cover, track info, current/next lyric, progress, and controls.
- **Interface**: The background follows the cover's dominant color; the cover has a matching glow; the playlist uses a translucent blurred background; the playback bar auto-hides when the pointer leaves the bottom; the mouse wheel over the cover adjusts volume.
- **Playback statistics**: Hold Left `Shift` for 0.5s to open the panel with the quality tier (Hi-Res / SQ / HQ), full-play and single-loop counts, total plays, daily average, and a song play ranking.
- **10-band equalizer**: 31Hz–16kHz, ±12dB; presets for Acoustic, Pop, Rock, Jazz, Classical, Electronic, Bass boost, Vocal, and Late night; manual changes switch to a custom curve; an auto preamp compensates for the largest boost; bypassed when off.
- **Playlists**: Right-click to add songs, drag to reorder, rename/delete; switch between the queue and the library.
- **Search and sorting**: Sort by title/artist or shuffle, with real-time filtering; an A-Z# index (Chinese sorted by pinyin) in title/artist modes.
- **System media controls**: Windows SMTC support for media keys and the system volume flyout, with cover, track info, and progress.
- **Chinese/English UI**: Interface copy and help are available in Chinese and English.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Space | Play / pause |
| Q / E | Previous / next track |
| R | Cycle play mode (list loop / single loop / shuffle) |
| Hold Left Alt 0.5s | Show / hide the playlist |
| Hold Left Ctrl 0.5s | Show / hide playlists |
| Hold Left Shift 0.5s | Show / hide playback statistics |
| F5 | Toggle mini mode |
| Ctrl + , | Open settings |
| Ctrl + Alt + L | Show / hide desktop lyrics |
| Ctrl + Alt + T | Show / hide taskbar lyrics |
| H | Open / close help |
| Esc | Close menu / overlay / drawer in order |
| Mouse wheel over the cover | Adjust volume |
| Click a lyric line | Seek to that position |

The taskbar lyrics shortcut (`Ctrl+Alt+T`) responds only to the left Ctrl/Alt keys to avoid conflicts with AltGr.

## Tech Stack

- Electron 40 (ESM)
- Vanilla JavaScript / CSS
- `electron-store`: settings and state persistence
- `music-metadata`: audio metadata and embedded cover art
- Web Audio API: 10 cascaded peaking BiquadFilter nodes plus an auto preamp
- `koffi` + Win32 API: taskbar lyric positioning, DPI, theme, and other Windows integration

## Development

Requirements: Node.js and npm.

```bash
npm install
npm start          # development
npm run build:win  # build the Windows installer
npm run format     # Prettier
```

The installer uses NSIS. The desktop shortcut is optional and disabled by default; silent updates leave desktop icons untouched.

## Project Structure

```text
Dreamisle-electron/
├── README.md                  # Chinese docs
├── README/README.en.md        # English docs
├── build/installer.nsh        # NSIS installer customization (desktop shortcut option)
├── img/                       # Documentation screenshots
└── src/
    ├── main/                  # Main process: windows, tray, library, playlists, persistence, IPC
    ├── preload/               # Preload bridges (main window / desktop lyrics / taskbar lyrics)
    ├── lyrics/                # Desktop lyrics overlay
    ├── taskbar/               # Windows taskbar lyrics (Win32 positioning, layout, renderer, log)
    ├── shared/                # Shared pure logic (lyrics parsing, i18n, equalizer, stats, taskbar lyric document/style)
    ├── renderer/              # Main window renderer (HTML / JS / CSS)
    └── assets/                # App icon
```

## License

MIT
