# R36S Dashboard 📊

[![Bun Version](https://img.shields.io/badge/Bun-%3E%3D1.0-blue?logo=bun&logoColor=white)](https://bun.sh)
[![Platform](https://img.shields.io/badge/Platform-R36S%20%2F%20RK3326-red)](https://github.com/sdolai/r36s-dashboard)
[![Release](https://img.shields.io/github/v/release/sdolai/r36s-dashboard?color=green&logo=github)](https://github.com/Dattebayooooo/r36s-dashboard/releases)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC)

A premium system status dashboard for the **R36S handheld gaming console** (Panel 4 / Rockchip RK3326 SoC). Built in **TypeScript** and compiled into a single self-contained, high-performance ARM64 binary with [Bun](https://bun.sh).

> [!NOTE]  
> **Zero runtime dependencies:** Works without X11, SDL, or GPU drivers. Renders directly to the hardware!

---

## 📺 Build Variants

| Variant         | Entry Point      | Rendering Engine                 | Description                                                                                   |
| :-------------- | :--------------- | :------------------------------- | :-------------------------------------------------------------------------------------------- |
| **Framebuffer** | `main.ts`        | `/dev/fb0` direct pixel writes   | Standard GUI with 8x8 bitmap font, 640x480 BGRA 32bpp resolution.                             |
| **Native TUI**  | `main-native.ts` | ANSI escape codes on `/dev/tty1` | Terminal UI using 16-color VT escape codes (80x30 characters, using the console's 8x16 font). |

Both versions read controller inputs directly via Linux `evdev` (`/dev/input/event*`) and support a `--dry-run` flag for convenient local testing.

---

## 🛠️ Prerequisites

- **[Bun](https://bun.sh)** (v1.0+) installed on your development machine.
- `make` utility for build automation.
- An R36S device running ArkOS, AmberELEC, or ROCKNIX connected to your local network (for SSH deployment).

---

## 🚀 Quick Start

### 1. Install Dependencies
Installs developer type definitions for Node/TypeScript:
```bash
bun install
```

### 2. Build
Compile the source code into a standalone Linux ARM64 binary (`r36s-app/r36s-app`):

* **Framebuffer version (Default):**
  ```bash
  make build
  ```
* **Native TUI version:**
  ```bash
  make build-native
  ```

### 3. Deploy
Update the SSH configuration (such as `SSH_HOST` or `SSH_USER`) in the [Makefile](file:///Users/sdolai/Documents/github/sdolai/r36s-dashboard/Makefile) or override them on the command line:

```bash
make deploy SSH_HOST=192.168.1.180
```
This target:
1. Connects to the R36S console via SSH/SCP.
2. Creates `/roms/ports/r36s-app/` and `/roms/tools/` folders.
3. Deploys the compiled dashboard binary and the launcher script (`r36s-dashboard.sh`) to their correct paths.
4. Sets execution permissions.

---

## 📦 Manual Installation / Releases

If you prefer not to build from source, you can download precompiled binaries from the [GitHub Releases](https://github.com/sdolai/r36s-dashboard/releases).

1. Download `r36s-app-framebuffer.zip` (or `r36s-app-native.zip`) and `r36s-dashboard.sh` from the latest release.
2. Unzip the archive directly into your console's `/roms/ports/` directory (it will create a `r36s-app` subfolder with the binary inside).
3. Copy `r36s-dashboard.sh` into your console's `/roms/tools/` directory.
4. Ensure script executable permissions: `chmod +x /roms/tools/r36s-dashboard.sh`.

Once installed, the dashboard will appear under the **Options** or **Tools** menu in EmulationStation.

---

## 💻 Local Development

Test the application on your computer using the `--dry-run` flag to skip direct hardware calls:

```bash
# Test Framebuffer version (simulates /dev/fb0 drawing)
bun main.ts --dry-run

# Test Native TUI version (draws directly to terminal stdout)
bun main-native.ts --dry-run
```

### Keyboard Controls (Simulation Mode)
- **Arrow Keys**: Navigate / Page layout actions
- **`[` / `]`**: Trigger L1 / R1 page switches
- **`q`** or **Ctrl+C**: Exit

---

## ✨ Features & Architecture

### 📊 Dashboard Pages
Navigate layouts with the gamepad's **L1/R1** bumpers or **D-Pad Left/Right**.

* **Status**: Live bars for CPU & memory, system temperature, load averages, uptime, and Bun heap metrics.
* **System**: OS details, Bun runtime, PID, root device mounting, working directory, and environment details.
* **Debug**: Real-time controller button presses, evdev input logging, and SELECT/START state indicator.
* **About**: Device hardware profile, firmware/software information, and gamepad button legend.

### 🎮 Gamepad Input (evdev)
- Monitors `/dev/input/event*` devices natively.
- Decodes standard 24-byte Linux `struct input_event` blocks.
- Maps standard keys (`BTN_SELECT` / `BTN_START`) as well as `BTN_TRIGGER_HAPPY` codes (704–709) used by the Panel 4 clone controller driver on the R36S.
- **Exit combo**: Press **SELECT + START** together.

### 🐧 Native TUI Details
The console terminal variant:
- Outputs directly to `/dev/tty1`.
- Manages console key-mapping lifecycles (`gptokeyb` process wrapper, if present at `/opt/inttools/gptokeyb`).
- Handles terminal resets, blanking, and hides the cursor console text overlays on start, restoring it on exit.
- Autodetects terminal grid dimensions dynamically using `stty size` (falls back to 80x30 standard).

---

## 🕹️ Controller Layout

| Gamepad Button         | Action                  |
| :--------------------- | :---------------------- |
| **L1 / R1**            | Switch Pages            |
| **D-Pad Left / Right** | Switch Pages            |
| **SELECT + START**     | Exit Application        |
| **q** / **Ctrl+C**     | Emergency keyboard exit |

---

## 🎯 Target Hardware & Compatibility

The dashboard has been verified and tested on **R36S Panel 4** hardware revisions.

| Specification       | Value / Target                      |
| :------------------ | :---------------------------------- |
| **Device**          | R36S (Panel 4)                      |
| **SoC**             | Rockchip RK3326                     |
| **Architecture**    | ARM64 (`aarch64`)                   |
| **Display**         | 640x480 @ 32bpp BGRA                |
| **Supported OS**    | ArkOS / ROCKNIX / AmberELEC         |
| **Framebuffer**     | `/dev/fb0`                          |
| **Input Interface** | Linux `evdev` (`/dev/input/event*`) |

---

## 📂 Project Structure

```
.
├── .github/workflows/
│   └── release.yml        # CI/CD Automated release pipeline
├── main.ts                # Framebuffer source code (draws to /dev/fb0)
├── main-native.ts         # Native TUI source code (ANSI console)
├── Makefile               # Automated build & deploy scripts
├── r36s-dashboard.sh      # Console launcher script (runs in tools)
├── package.json           # Project configuration & script shortcuts
└── r36s-app/
    └── r36s-app           # Compiled output binary (created after build)
```

---

## 📄 License

This project is licensed under the **ISC License**. See the `LICENSE` file (if present) or package metadata for details.
