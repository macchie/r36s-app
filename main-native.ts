/**
 * R36S Panel 4 — Terminal UI Dashboard (Native)
 * Renders system info using basic ANSI escape codes — no framebuffer required.
 * Compatible with Linux VT/fbcon (16-color, ASCII-only, no alternate screen).
 * Reads gamepad input from /dev/input/event* (evdev) or via gptokeyb.
 *
 * Follows the R36S native script conventions:
 *  - Outputs to /dev/tty1 (or stdout in dry-run mode)
 *  - Resets terminal on startup (\033c)
 *  - Sets TERM=linux
 *  - Manages gptokeyb lifecycle for controller support
 *  - Cleans up on exit (cursor restore, gptokeyb kill, terminal reset)
 */

import {
  readFileSync,
  readdirSync,
  createReadStream,
  openSync,
  writeSync,
  closeSync,
  existsSync,
} from "fs";
import { execSync, spawn, type ChildProcess } from "child_process";
import { version } from "./package.json";

// ============================================================================
// Configuration
// ============================================================================
const CURR_TTY = "/dev/tty1";
const GPTOKEYB_BIN = "/opt/inttools/gptokeyb";
const GPTOKEYB_KEYS = "/opt/inttools/keys.gptk";
const GPTOKEYB_CONTROLLER_DB = "/opt/inttools/gamecontrollerdb.txt";
const SCRIPT_NAME = "r36s-native";

// ============================================================================
// R36S display constants
// 640x480 framebuffer with 8x16 fbcon font = 80 cols x 30 rows
// ============================================================================
const R36S_COLS = 80;
const R36S_ROWS = 30;

// ============================================================================
// TTY Output Writer
// ============================================================================
class TtyWriter {
  private fd: number | null = null;
  private useTty: boolean;
  cols: number;
  rows: number;

  constructor(dryRun: boolean) {
    this.useTty = !dryRun;
    if (this.useTty) {
      try {
        this.fd = openSync(CURR_TTY, "w");
      } catch {
        this.useTty = false;
      }
    }

    // Detect terminal dimensions:
    // 1. Try stty on the target TTY (most accurate on device)
    // 2. Try process.stdout (works in dry-run / SSH)
    // 3. Fall back to known R36S dimensions
    this.cols = R36S_COLS;
    this.rows = R36S_ROWS;

    if (this.useTty) {
      try {
        const out = execSync(`stty size < ${CURR_TTY} 2>/dev/null`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();
        const [r, c] = out.split(/\s+/).map(Number);
        if (r > 0 && c > 0) {
          this.rows = r;
          this.cols = c;
        }
      } catch {}
    } else {
      // Dry-run: use stdout dimensions if available
      if (process.stdout.columns && process.stdout.columns > 0) {
        this.cols = process.stdout.columns;
      }
      if (process.stdout.rows && process.stdout.rows > 0) {
        this.rows = process.stdout.rows;
      }
    }
  }

  write(data: string) {
    if (this.useTty && this.fd !== null) {
      const buf = Buffer.from(data);
      try {
        writeSync(this.fd, buf);
      } catch {}
    } else {
      process.stdout.write(data);
    }
  }

  close() {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
  }
}

// ============================================================================
// gptokeyb Controller Manager
// ============================================================================
class GptokeybManager {
  private proc: ChildProcess | null = null;

  start() {
    if (!existsSync(GPTOKEYB_BIN)) return;

    // Kill any existing gptokeyb instances
    try {
      execSync("pkill -9 -f gptokeyb 2>/dev/null", { stdio: "ignore" });
    } catch {}

    // Ensure /dev/uinput is accessible
    if (existsSync("/dev/uinput")) {
      try {
        execSync("chmod 666 /dev/uinput 2>/dev/null", { stdio: "ignore" });
      } catch {}
    }

    // Set controller config environment
    if (existsSync(GPTOKEYB_CONTROLLER_DB)) {
      process.env.SDL_GAMECONTROLLERCONFIG_FILE = GPTOKEYB_CONTROLLER_DB;
    }

    // Spawn gptokeyb
    const args = ["-1", SCRIPT_NAME];
    if (existsSync(GPTOKEYB_KEYS)) {
      args.push("-c", GPTOKEYB_KEYS);
    }

    this.proc = spawn(GPTOKEYB_BIN, args, {
      stdio: "ignore",
      detached: true,
    });
    this.proc.unref();
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      this.proc = null;
    }
    // Also kill by name pattern to catch orphans
    try {
      execSync(`pkill -f "gptokeyb -1 ${SCRIPT_NAME}" 2>/dev/null`, { stdio: "ignore" });
    } catch {}
  }
}

// ============================================================================
// ANSI 16-color codes (Linux VT compatible)
// ============================================================================
const FG = {
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
};

const BG = {
  black: "\x1b[40m",
  red: "\x1b[41m",
  green: "\x1b[42m",
  yellow: "\x1b[43m",
  blue: "\x1b[44m",
  magenta: "\x1b[45m",
  cyan: "\x1b[46m",
  white: "\x1b[47m",
  gray: "\x1b[100m",
  brightBlue: "\x1b[104m",
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";


// ============================================================================
// Terminal Renderer (Linux VT compatible)
// ============================================================================
class TerminalRenderer {
  private buf = "";
  private ttyWriter: TtyWriter;
  rows: number;
  cols: number;

  constructor(ttyWriter: TtyWriter) {
    this.ttyWriter = ttyWriter;
    this.rows = ttyWriter.rows;
    this.cols = ttyWriter.cols;
  }

  updateSize() {
    // Dimensions are fixed from TtyWriter detection — no runtime re-query
    // (SIGWINCH won't fire when writing to /dev/tty1 via fd)
  }

  private w(s: string) { this.buf += s; }

  moveTo(row: number, col: number) {
    this.w(`\x1b[${row};${col}H`);
  }

  write(text: string) { this.buf += text; }

  writeAt(row: number, col: number, text: string, fg = "", bg = "") {
    this.moveTo(row, col);
    if (fg) this.w(fg);
    if (bg) this.w(bg);
    this.w(text);
    if (fg || bg) this.w(RESET);
  }

  fillRow(row: number, col: number, width: number, bg: string) {
    this.moveTo(row, col);
    this.w(bg);
    this.w(" ".repeat(Math.max(0, width)));
    this.w(RESET);
  }

  hline(row: number, col: number, width: number, ch = "-", fg = "") {
    this.moveTo(row, col);
    if (fg) this.w(fg);
    this.w(ch.repeat(Math.max(0, width)));
    if (fg) this.w(RESET);
  }

  box(row: number, col: number, w: number, h: number, borderFg = FG.blue) {
    this.moveTo(row, col);
    this.w(borderFg);
    this.w("+" + "-".repeat(w - 2) + "+");
    for (let r = 1; r < h - 1; r++) {
      this.moveTo(row + r, col);
      this.w("|" + " ".repeat(w - 2) + "|");
    }
    this.moveTo(row + h - 1, col);
    this.w("+" + "-".repeat(w - 2) + "+");
    this.w(RESET);
  }

  bar(row: number, col: number, w: number, percent: number, label: string) {
    const inner = w - 2;
    const filled = Math.round((Math.min(percent, 100) / 100) * inner);
    const empty = inner - filled;
    const barFg = percent > 80 ? FG.brightRed : percent > 50 ? FG.brightYellow : FG.brightGreen;

    this.moveTo(row, col);
    this.w(FG.blue + "[" + RESET);
    this.w(barFg + "#".repeat(filled) + RESET);
    this.w(FG.gray + ".".repeat(empty) + RESET);
    this.w(FG.blue + "]" + RESET);
    this.w(" " + FG.white + label + RESET);
  }

  clear() {
    this.buf = "";
    this.w("\x1b[2J\x1b[H");
  }

  flush() {
    this.ttyWriter.write(this.buf);
    this.buf = "";
  }
}

// ============================================================================
// Input — Button codes
// ============================================================================
enum Btn {
  SOUTH = 304, EAST = 305, NORTH = 307, WEST = 308,
  TL = 310, TR = 311, TL2 = 312, TR2 = 313,
  SELECT = 314, START = 315,
  DPAD_UP = 544, DPAD_DOWN = 545, DPAD_LEFT = 546, DPAD_RIGHT = 547,
  TRIGGER_HAPPY1 = 704, TRIGGER_HAPPY2 = 705,
  TRIGGER_HAPPY3 = 706, TRIGGER_HAPPY4 = 707,
  TRIGGER_HAPPY5 = 708, TRIGGER_HAPPY6 = 709,
}

const SELECT_CODES = new Set([Btn.SELECT, Btn.TRIGGER_HAPPY3, Btn.TRIGGER_HAPPY1]);
const START_CODES = new Set([Btn.START, Btn.TRIGGER_HAPPY4, Btn.TRIGGER_HAPPY2]);

type Action = "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select" | "l1" | "r1" | "quit";

interface RawEvent {
  device: string;
  type: number;
  code: number;
  value: number;
  time: number;
}

const EVENT_LOG: RawEvent[] = [];
const MAX_EVENT_LOG = 40;

function logRawEvent(ev: RawEvent) {
  EVENT_LOG.push(ev);
  if (EVENT_LOG.length > MAX_EVENT_LOG) EVENT_LOG.shift();
}

// ============================================================================
// Evdev Input Reader
// ============================================================================
class InputReader {
  private streams: ReturnType<typeof createReadStream>[] = [];
  private onAction: (action: Action) => void;
  private onRelease: (action: Action) => void;
  private heldKeys = new Set<number>();

  constructor(onAction: (action: Action) => void, onRelease: (action: Action) => void) {
    this.onAction = onAction;
    this.onRelease = onRelease;
  }

  start() {
    const devices: string[] = [];
    try {
      const entries = readdirSync("/dev/input").sort();
      for (const entry of entries) {
        if (entry.startsWith("event")) {
          devices.push(`/dev/input/${entry}`);
        }
      }
    } catch {}

    if (devices.length === 0) devices.push("/dev/input/event0");

    for (const dev of devices) {
      try {
        const stream = createReadStream(dev, { highWaterMark: 24 * 64 });
        stream.on("data", (buf: Buffer) => this.parseEvents(buf, dev));
        stream.on("error", () => {});
        this.streams.push(stream);
      } catch {}
    }
  }

  stop() {
    for (const s of this.streams) s.destroy();
    this.streams = [];
  }

  private parseEvents(buf: Buffer, device: string) {
    const EVENT_SIZE = 24;
    for (let off = 0; off + EVENT_SIZE <= buf.length; off += EVENT_SIZE) {
      const type = buf.readUInt16LE(off + 16);
      const code = buf.readUInt16LE(off + 18);
      const value = buf.readInt32LE(off + 20);

      if (type !== 0) {
        logRawEvent({ device, type, code, value, time: Date.now() });
      }

      if (type === 1) {
        if (value === 1) {
          this.heldKeys.add(code);
          this.handleKey(code);
        } else if (value === 0) {
          this.heldKeys.delete(code);
          const action = this.codeToAction(code);
          if (action) this.onRelease(action);
        }
      } else if (type === 3) {
        if (code === 16) {
          if (value < 0) this.onAction("left");
          else if (value > 0) this.onAction("right");
        } else if (code === 17) {
          if (value < 0) this.onAction("up");
          else if (value > 0) this.onAction("down");
        }
      }
    }
  }

  private isSelectCode(code: number): boolean { return SELECT_CODES.has(code); }
  private isStartCode(code: number): boolean { return START_CODES.has(code); }

  private codeToAction(code: number): Action | null {
    if (this.isSelectCode(code)) return "select";
    if (this.isStartCode(code)) return "start";
    switch (code) {
      case Btn.SOUTH: return "a";
      case Btn.EAST: return "b";
      case Btn.TL: return "l1";
      case Btn.TR: return "r1";
      case Btn.DPAD_UP: return "up";
      case Btn.DPAD_DOWN: return "down";
      case Btn.DPAD_LEFT: return "left";
      case Btn.DPAD_RIGHT: return "right";
      default: return null;
    }
  }

  private isAnySelectHeld(): boolean {
    for (const code of SELECT_CODES) if (this.heldKeys.has(code)) return true;
    return false;
  }

  private isAnyStartHeld(): boolean {
    for (const code of START_CODES) if (this.heldKeys.has(code)) return true;
    return false;
  }

  private handleKey(code: number) {
    if (
      (this.isStartCode(code) && this.isAnySelectHeld()) ||
      (this.isSelectCode(code) && this.isAnyStartHeld())
    ) {
      return this.onAction("quit");
    }
    const action = this.codeToAction(code);
    if (action) this.onAction(action);
  }
}

// ============================================================================
// Keyboard fallback (for SSH / dry-run debugging)
// ============================================================================
function setupKeyboard(onAction: (action: Action) => void) {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key: string) => {
    if (key === "\x1b[A") onAction("up");
    else if (key === "\x1b[B") onAction("down");
    else if (key === "\x1b[D") onAction("left");
    else if (key === "\x1b[C") onAction("right");
    else if (key === "\r" || key === " ") onAction("a");
    else if (key === "\x1b" || key === "b") onAction("b");
    else if (key === "q" || key === "\x03") onAction("quit");
    else if (key === "[" || key === ",") onAction("l1");
    else if (key === "]" || key === ".") onAction("r1");
  });
}

// ============================================================================
// System Stats
// ============================================================================
interface CpuTimes { idle: number; total: number; }

function readCpuTimes(): CpuTimes {
  try {
    const stat = readFileSync("/proc/stat", "utf8");
    const parts = stat.split("\n")[0].split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] ?? 0);
    return { idle, total: parts.reduce((a, b) => a + b, 0) };
  } catch { return { idle: 0, total: 0 }; }
}

function getCpuPercent(prev: CpuTimes, curr: CpuTimes): number {
  const dTotal = curr.total - prev.total;
  const dIdle = curr.idle - prev.idle;
  if (dTotal === 0) return 0;
  return Math.round(((dTotal - dIdle) / dTotal) * 100);
}

interface MemInfo { totalMB: number; usedMB: number; percent: number; }

function getMemInfo(): MemInfo {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const get = (key: string) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? parseInt(m[1], 10) : 0;
    };
    const total = get("MemTotal");
    const free = get("MemFree");
    const used = total - free - get("Buffers") - get("Cached");
    return { totalMB: Math.round(total / 1024), usedMB: Math.round(used / 1024), percent: Math.round((used / total) * 100) };
  } catch {
    const mem = process.memoryUsage();
    return { totalMB: 0, usedMB: Math.round(mem.heapUsed / 1024 / 1024), percent: 0 };
  }
}

function getUptime(): string {
  try {
    const secs = Math.floor(parseFloat(readFileSync("/proc/uptime", "utf8").trim().split(" ")[0]));
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ${secs % 60}s`;
  } catch { return "N/A"; }
}

function getCpuTemp(): string {
  try {
    return `${(parseInt(readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim(), 10) / 1000).toFixed(1)}C`;
  } catch { return "N/A"; }
}

function getDiskInfo(): string {
  try {
    const rootLine = readFileSync("/proc/mounts", "utf8").split("\n").find((l) => l.includes(" / "));
    return rootLine ? rootLine.split(" ")[0] : "N/A";
  } catch { return "N/A"; }
}

function getLoadAvg(): string {
  try {
    const parts = readFileSync("/proc/loadavg", "utf8").trim().split(" ");
    return `${parts[0]} ${parts[1]} ${parts[2]}`;
  } catch { return "N/A"; }
}

// ============================================================================
// App State
// ============================================================================
const PAGES = ["Status", "System", "Debug", "About"] as const;

interface AppState {
  currentPage: number;
  running: boolean;
  tick: number;
  prevCpu: CpuTimes;
  cpuPercent: number;
  dirty: boolean;
  selectHeld: boolean;
  startHeld: boolean;
}

// ============================================================================
// Page Renderers
// ============================================================================
function renderHeader(t: TerminalRenderer, state: AppState) {
  const W = t.cols;

  t.fillRow(1, 1, W, BG.blue);
  t.writeAt(1, 2, ` R36S Dashboard v${version}`, BOLD + FG.brightWhite, BG.blue);
  const timeStr = new Date().toLocaleTimeString();
  t.writeAt(1, W - timeStr.length - 1, timeStr, FG.brightYellow, BG.blue);

  t.hline(2, 1, W, "=", FG.brightBlue);

  t.writeAt(3, 2, "<L1", FG.gray);

  const tabStart = 7;
  const tabArea = W - 14;
  const tabW = Math.floor(tabArea / PAGES.length);

  for (let i = 0; i < PAGES.length; i++) {
    const x = tabStart + i * tabW;
    const label = ` ${PAGES[i]} `;

    if (i === state.currentPage) {
      t.writeAt(3, x, label, BOLD + FG.brightWhite, BG.blue);
    } else {
      t.writeAt(3, x, label, FG.gray);
    }
  }

  t.writeAt(3, W - 3, "R1>", FG.gray);
  t.hline(4, 1, W, "-", FG.blue);
}

function renderFooter(t: TerminalRenderer, state: AppState) {
  const W = t.cols;
  const row = t.rows;

  t.hline(row - 1, 1, W, "-", FG.blue);
  t.fillRow(row, 1, W, BG.blue);
  t.writeAt(row, 2, " <L1", FG.brightWhite, BG.blue);

  const center = "SEL+START Exit";
  t.writeAt(row, Math.floor((W - center.length) / 2), center, FG.white, BG.blue);

  const pageStr = `${state.currentPage + 1}/${PAGES.length}`;
  t.writeAt(row, W - pageStr.length - 6, pageStr, FG.brightWhite, BG.blue);
  t.writeAt(row, W - 4, "R1> ", FG.brightWhite, BG.blue);
}

function renderStatusPage(t: TerminalRenderer, state: AppState, startRow: number) {
  const W = t.cols;
  const mem = getMemInfo();
  let row = startRow;

  const barW = Math.min(W - 16, 50);
  t.writeAt(row, 3, "CPU ", BOLD + FG.white);
  t.bar(row, 8, barW, state.cpuPercent, `${state.cpuPercent}%`);
  row += 2;

  t.writeAt(row, 3, "MEM ", BOLD + FG.white);
  t.bar(row, 8, barW, mem.percent, `${mem.usedMB}/${mem.totalMB}MB (${mem.percent}%)`);
  row += 2;

  const boxW = Math.min(W - 4, 56);
  const cpuTemp = getCpuTemp();
  const tempVal = parseFloat(cpuTemp);
  const stats = [
    { label: "CPU Temp", value: cpuTemp, fg: tempVal > 70 ? FG.brightRed : tempVal > 55 ? FG.brightYellow : FG.brightGreen },
    { label: "Load Avg", value: getLoadAvg(), fg: FG.brightGreen },
    { label: "Uptime", value: getUptime(), fg: FG.brightGreen },
    { label: "Heap", value: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, fg: FG.brightGreen },
  ];

  t.box(row, 3, boxW, stats.length + 2);
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    const r = row + 1 + i;
    t.writeAt(r, 5, "*", s.fg);
    t.writeAt(r, 7, s.label.padEnd(12), FG.cyan);
    t.writeAt(r, boxW - s.value.length + 1, s.value, BOLD + FG.white);
  }
  row += stats.length + 3;

  const spinChars = ["-", "\\", "|", "/"];
  const spin = spinChars[state.tick % spinChars.length];
  t.writeAt(row, 3, `Heartbeat ${spin}`, FG.brightGreen);
}

function renderSystemPage(t: TerminalRenderer, startRow: number) {
  const W = t.cols;
  const boxW = Math.min(W - 4, 56);
  let row = startRow;

  const sysRows = [
    { label: "Platform", value: `${process.platform} ${process.arch}` },
    { label: "Runtime", value: `Bun ${process.version}` },
    { label: "PID", value: `${process.pid}` },
    { label: "Root Dev", value: getDiskInfo() },
    { label: "CWD", value: process.cwd() },
  ];

  t.box(row, 3, boxW, sysRows.length + 2);
  for (let i = 0; i < sysRows.length; i++) {
    const r = sysRows[i];
    const y = row + 1 + i;
    t.writeAt(y, 5, r.label.padEnd(12), FG.cyan);
    const maxVal = boxW - 18;
    const val = r.value.length > maxVal ? r.value.slice(0, maxVal - 2) + ".." : r.value;
    t.writeAt(y, boxW - val.length + 1, val, FG.white);
  }
  row += sysRows.length + 3;

  t.writeAt(row, 3, "Environment", FG.cyan);
  row += 1;

  const envKeys = ["HOME", "USER", "SHELL", "TERM", "DISPLAY"];
  t.box(row, 3, boxW, envKeys.length + 2);
  for (let i = 0; i < envKeys.length; i++) {
    const key = envKeys[i];
    const val = process.env[key] ?? "N/A";
    const y = row + 1 + i;
    t.writeAt(y, 5, key.padEnd(10), FG.brightCyan);
    const maxVal = boxW - 16;
    const dv = val.length > maxVal ? val.slice(0, maxVal - 2) + ".." : val;
    t.writeAt(y, boxW - dv.length + 1, dv, FG.white);
  }
}

function renderDebugPage(t: TerminalRenderer, state: AppState, startRow: number) {
  const W = t.cols;
  const boxW = Math.min(W - 4, 64);
  let row = startRow;

  t.box(row, 3, boxW, 3);
  t.writeAt(row + 1, 5, "SELECT ", FG.cyan);
  if (state.selectHeld) {
    t.writeAt(row + 1, 12, "[HELD]", BOLD + FG.brightGreen);
  } else {
    t.writeAt(row + 1, 12, "[ -- ]", FG.gray);
  }
  t.writeAt(row + 1, 22, "START ", FG.cyan);
  if (state.startHeld) {
    t.writeAt(row + 1, 28, "[HELD]", BOLD + FG.brightGreen);
  } else {
    t.writeAt(row + 1, 28, "[ -- ]", FG.gray);
  }
  row += 4;

  t.writeAt(row, 3, "Event Log", FG.cyan);
  row += 1;

  const maxRows = Math.min(t.rows - row - 3, 18);
  const events = EVENT_LOG.slice().reverse();
  const logH = Math.max(maxRows + 2, 4);
  t.box(row, 3, boxW, logH);

  t.writeAt(row + 1, 5, "DEV".padEnd(12) + "TYPE".padEnd(8) + "CODE".padEnd(8) + "VALUE", DIM + FG.white);

  for (let i = 0; i < Math.min(events.length, maxRows - 1); i++) {
    const ev = events[i];
    const y = row + 2 + i;

    const devShort = ev.device.replace("/dev/input/", "");
    const typeName = ev.type === 1 ? "EV_KEY" : ev.type === 3 ? "EV_ABS" : `T=${ev.type}`;
    const valueName = ev.type === 1
      ? ev.value === 1 ? "PRESS" : ev.value === 0 ? "RELEASE" : "REPEAT"
      : String(ev.value);
    const fg = ev.type === 1 && ev.value === 1 ? FG.brightGreen : FG.gray;

    t.writeAt(y, 5, devShort.padEnd(12) + typeName.padEnd(8) + String(ev.code).padEnd(8) + valueName, fg);
  }

  if (events.length === 0) {
    t.writeAt(row + 2, 5, "No events yet. Press any button.", FG.gray);
  }
}

function renderAboutPage(t: TerminalRenderer, startRow: number) {
  const W = t.cols;
  const boxW = Math.min(W - 4, 56);
  let row = startRow;

  const title = "R36S Panel 4 Dashboard";
  t.writeAt(row, Math.floor((W - title.length) / 2), title, BOLD + FG.brightWhite);
  row += 1;
  const verStr = `Version ${version}`;
  t.writeAt(row, Math.floor((W - verStr.length) / 2), verStr, FG.gray);
  row += 1;

  const barLen = 20;
  t.hline(row, Math.floor((W - barLen) / 2), barLen, "=", FG.brightBlue);
  row += 2;

  t.writeAt(row, 3, "Hardware", FG.cyan);
  row += 1;
  const specs = [
    { label: "SoC", value: "Rockchip RK3326" },
    { label: "Display", value: "640x480 BGRA 32bpp" },
    { label: "Runtime", value: "Bun (compiled ARM64)" },
  ];
  t.box(row, 3, boxW, specs.length + 2);
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const y = row + 1 + i;
    t.writeAt(y, 5, s.label.padEnd(12), FG.cyan);
    t.writeAt(y, boxW - s.value.length + 1, s.value, FG.white);
  }
  row += specs.length + 3;

  t.writeAt(row, 3, "Controls", FG.cyan);
  row += 1;
  const controls = [
    { label: "L1 / R1", value: "Switch pages" },
    { label: "D-pad", value: "Navigate" },
    { label: "SEL+START", value: "Exit app" },
  ];
  t.box(row, 3, boxW, controls.length + 2);
  for (let i = 0; i < controls.length; i++) {
    const c = controls[i];
    const y = row + 1 + i;
    t.writeAt(y, 5, c.label.padEnd(12), FG.brightCyan);
    t.writeAt(y, boxW - c.value.length + 1, c.value, FG.white);
  }
}

// ============================================================================
// Main Renderer
// ============================================================================
function render(t: TerminalRenderer, state: AppState) {
  t.updateSize();
  t.clear();

  const currCpu = readCpuTimes();
  state.cpuPercent = getCpuPercent(state.prevCpu, currCpu);
  state.prevCpu = currCpu;

  renderHeader(t, state);
  renderFooter(t, state);

  const contentStart = 6;
  switch (PAGES[state.currentPage]) {
    case "Status":
      renderStatusPage(t, state, contentStart);
      break;
    case "System":
      renderSystemPage(t, contentStart);
      break;
    case "Debug":
      renderDebugPage(t, state, contentStart);
      break;
    case "About":
      renderAboutPage(t, contentStart);
      break;
  }

  t.flush();
  state.tick++;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Set environment variables matching R36S native conventions
  process.env.TERM = "linux";
  process.env.XDG_RUNTIME_DIR = `/run/user/${process.getuid?.() ?? 0}`;

  // Initialize TTY output
  const ttyWriter = new TtyWriter(dryRun);

  // Reset terminal — full reset (\033c) clears screen, resets attributes, moves cursor home
  ttyWriter.write("\x1bc");

  // Hide cursor on the target TTY
  ttyWriter.write("\x1b[?25l");

  // Initialize gptokeyb for controller support
  const gptokeyb = new GptokeybManager();
  if (!dryRun) {
    gptokeyb.start();
  }

  const t = new TerminalRenderer(ttyWriter);

  const state: AppState = {
    currentPage: 0,
    running: true,
    tick: 0,
    prevCpu: readCpuTimes(),
    cpuPercent: 0,
    dirty: true,
    selectHeld: false,
    startHeld: false,
  };

  let exiting = false;

  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    state.running = false;

    // Stop input streams
    input.stop();

    // Stop gptokeyb
    gptokeyb.stop();

    // Restore terminal: reset + show cursor
    ttyWriter.write("\x1bc\x1b[?25h");
    ttyWriter.close();

    // Restore stdin if in raw mode
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }

    process.exit(0);
  };

  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRender = () => {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(scheduleRender, 1000);
    if (!state.running) return;
    render(t, state);
    state.dirty = false;
  };

  const handleAction = (action: Action) => {
    if (action === "select") {
      state.selectHeld = true;
      if (state.startHeld) { shutdown(); return; }
      state.dirty = true;
      scheduleRender();
      return;
    }
    if (action === "start") {
      state.startHeld = true;
      if (state.selectHeld) { shutdown(); return; }
      state.dirty = true;
      scheduleRender();
      return;
    }
    if (action === "quit") { shutdown(); return; }

    switch (action) {
      case "left": case "l1":
        state.currentPage = (state.currentPage - 1 + PAGES.length) % PAGES.length;
        state.dirty = true;
        break;
      case "right": case "r1":
        state.currentPage = (state.currentPage + 1) % PAGES.length;
        state.dirty = true;
        break;
      default:
        if (PAGES[state.currentPage] === "Debug") state.dirty = true;
        break;
    }
    if (state.dirty) scheduleRender();
  };

  const handleRelease = (action: Action) => {
    if (action === "select") state.selectHeld = false;
    if (action === "start") state.startHeld = false;
    if (PAGES[state.currentPage] === "Debug") {
      state.dirty = true;
      scheduleRender();
    }
  };

  const input = new InputReader(handleAction, handleRelease);
  if (!dryRun) {
    input.start();
  }
  setupKeyboard(handleAction);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGWINCH", () => {
    state.dirty = true;
    scheduleRender();
  });

  scheduleRender();
}

main().catch((err) => {
  // Restore terminal on fatal error
  try {
    process.stdout.write("\x1bc\x1b[?25h");
  } catch {}
  console.error("Fatal:", err);
  process.exit(1);
});
