# R36S APP

A system status dashboard for the **R36S handheld** (Panel 4 / RK3326). Written in TypeScript, compiled to a standalone ARM64 binary with [Bun](https://bun.sh).

**Zero runtime dependencies** -- no X11, no SDL, no GPU drivers.

## Build Variants

| Variant | Entry Point | Rendering | Description |
|---------|-------------|-----------|-------------|
| **Framebuffer** | `main.ts` | `/dev/fb0` direct pixel writes | Full graphical UI with 8x8 bitmap font, 640x480 BGRA 32bpp |
| **Native** | `main-native.ts` | ANSI escape codes on `/dev/tty1` | Terminal UI using 16-color VT codes, 80x30 chars (fbcon 8x16 font) |

Both variants read gamepad input from `/dev/input/event*` (evdev) and support the `--dry-run` flag for local development.

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- `make`
- An R36S device with ArkOS, ROCKNIX, or AmberELEC (for running on hardware)

## Install Dependencies

```bash
bun install
```

This installs dev dependencies (`@types/node`) used for TypeScript type checking.

## Build

Build the **framebuffer** version (default):

```bash
make build
```

Build the **native** (terminal) version:

```bash
make build-native
```

Both commands compile the TypeScript source into a standalone ARM64 binary at `r36s-app/r36s-app` using `bun build --compile --target=bun-linux-arm64`.

## Deploy to Device

Requires SSH access to the R36S (edit the IP address in the `Makefile` to match your device).

```bash
# Deploy to Device
make deploy
```

This builds and copies the binary to `/roms/ports/r36s-app/` on the device via SCP.
Must enable Remote Services on device for it to work.

## Device Setup

1. Copy `r36s-app/r36s-app` and `r36s-app.sh` to `/roms/ports/r36s-app/` on the device
2. The launcher script (`r36s-app.sh`) handles:
   - Terminal buffer reset and cursor blanking
   - Binary permission setup
   - Stderr logging to `error.log`
   - Post-exit cleanup and return to EmulationStation

## Local Development

Run locally with the `--dry-run` flag to skip hardware access:

```bash
# Framebuffer version (skips /dev/fb0)
bun main.ts --dry-run

# Native version (renders to stdout instead of /dev/tty1)
bun main-native.ts --dry-run
```

Uses keyboard input: arrow keys to navigate, `[`/`]` for L1/R1, `q` or Ctrl+C to quit.

## Features

### Dashboard Pages

Navigate with **L1/R1** or **D-pad Left/Right**.

| Page | Content |
|------|---------|
| **Status** | CPU/memory usage bars, CPU temperature, load average, uptime, heap usage |
| **System** | Platform, runtime version, PID, root device, CWD, environment variables |
| **Debug** | Live SELECT/START held state, raw evdev event log with press/release tracking |
| **About** | Hardware specs, version info, control reference |

### Gamepad Input

- Reads all `/dev/input/event*` devices via Linux evdev
- Parses 24-byte `struct input_event`: `EV_KEY` for buttons, `EV_ABS` for D-pad hat
- Handles both standard `BTN_SELECT`/`BTN_START` (314/315) and `BTN_TRIGGER_HAPPY` codes (704-709) used by the R36S Panel 4 ODROID-GO2 joypad driver
- SELECT+START combo to exit

### Native Version Extras

The native build (`main-native.ts`) follows R36S script conventions:

- Outputs directly to `/dev/tty1`
- Manages `gptokeyb` lifecycle for controller-to-keyboard mapping (if available at `/opt/inttools/gptokeyb`)
- Sets `TERM=linux` and resets the terminal on startup/exit
- Auto-detects terminal dimensions via `stty size`, falls back to 80x30 (640x480 / 8x16 font)

## Controls

| Button | Action |
|--------|--------|
| L1 / R1 | Switch page |
| D-pad Left / Right | Switch page |
| SELECT + START | Exit application |
| q / Ctrl+C | Exit (keyboard fallback) |

## Target Hardware

| Spec | Value |
|------|-------|
| Device | R36S Panel 4 |
| SoC | Rockchip RK3326 |
| Architecture | ARM64 (aarch64) |
| Display | 640x480 @ 32bpp BGRA |
| OS | ArkOS / ROCKNIX / AmberELEC |
| Framebuffer | `/dev/fb0` |
| Input | `/dev/input/event*` (evdev) |

## Project Structure

```
.
├── main.ts            # Framebuffer version (renders to /dev/fb0)
├── main-native.ts     # Native terminal version (ANSI on /dev/tty1)
├── package.json       # Project metadata and dev dependencies
├── Makefile           # Build and deploy commands
├── r36s-app.sh        # Launcher script for the device
└── r36s-app/
    └── r36s-app       # Compiled ARM64 binary (after build)
```

## License

ISC
