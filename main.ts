/**
 * R36S Panel 4 — Framebuffer Status Dashboard
 * Renders system info directly to /dev/fb0 (640x480 BGRA 32bpp)
 * Reads gamepad input from /dev/input/event* (evdev)
 */

import {
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  readdirSync,
  createReadStream,
  existsSync,
} from "fs";
import { version } from "./package.json";

// ============================================================================
// VT Console cursor control
// ============================================================================
function hideVtCursor() {
  // Hide cursor via stdout escape codes
  process.stdout.write("\x1b[?25l"); // hide cursor
  process.stdout.write("\x1b[2J"); // clear screen
  process.stdout.write("\x1b[H"); // home cursor
  // Also try writing directly to the active VT
  for (const tty of ["/dev/tty0", "/dev/tty1"]) {
    try {
      if (existsSync(tty)) {
        const fd = openSync(tty, "w");
        const buf = Buffer.from("\x1b[?25l\x1b[2J\x1b[H");
        writeSync(fd, buf);
        closeSync(fd);
      }
    } catch {}
  }
}

function showVtCursor() {
  process.stdout.write("\x1b[?25h");
  for (const tty of ["/dev/tty0", "/dev/tty1"]) {
    try {
      if (existsSync(tty)) {
        const fd = openSync(tty, "w");
        const buf = Buffer.from("\x1b[?25h");
        writeSync(fd, buf);
        closeSync(fd);
      }
    } catch {}
  }
}

// ============================================================================
// Colors (BGRA format)
// ============================================================================
const COLOR = {
  bg: 0xff2e1a1a, // #1a1a2e
  headerBg: 0xff60340f, // #0f3460
  white: 0xffffffff,
  green: 0xff32e650, // #50e632
  red: 0xff3636e6, // #e63636
  yellow: 0xff00d4ff, // #ffd400
  gray: 0xff888888,
  dimGray: 0xff555555,
  barBg: 0xff3a3a3a,
  barFill: 0xff32e650,
  highlight: 0xff804020, // #204080 selected item bg
  cyan: 0xffffff00, // #00ffff
  // Panel / card system
  panelBg: 0xff402222, // #222240
  panelBorder: 0xff5e3a3a, // #3a3a5e
  accentBlue: 0xffff8844, // #4488ff
  footerBg: 0xff401a12, // #121a40
  // Row shading
  rowAlt: 0xff352020, // #202035
};

// ============================================================================
// Input — Button codes
// ============================================================================
enum Btn {
  // Gamepad (evdev key codes — standard)
  SOUTH = 304, // A
  EAST = 305, // B
  NORTH = 307, // X
  WEST = 308, // Y
  TL = 310, // L1
  TR = 311, // R1
  TL2 = 312, // L2
  TR2 = 313, // R2
  SELECT = 314, // Standard BTN_SELECT
  START = 315, // Standard BTN_START
  // D-pad as buttons (some R36S configs)
  DPAD_UP = 544,
  DPAD_DOWN = 545,
  DPAD_LEFT = 546,
  DPAD_RIGHT = 547,
  // R36S Panel 4 / ODROID-GO2 (RK3326) uses BTN_TRIGGER_HAPPY
  // for function buttons instead of BTN_SELECT/BTN_START
  TRIGGER_HAPPY1 = 704, // may map to select/fn
  TRIGGER_HAPPY2 = 705,
  TRIGGER_HAPPY3 = 706, // select on some R36S configs
  TRIGGER_HAPPY4 = 707, // start on some R36S configs
  TRIGGER_HAPPY5 = 708,
  TRIGGER_HAPPY6 = 709,
}

// All evdev codes that mean "select" or "start" on the R36S Panel 4
const SELECT_CODES = new Set([
  Btn.SELECT,         // 314 — standard
  Btn.TRIGGER_HAPPY3, // 706 — ODROID-GO2/RK3326
  Btn.TRIGGER_HAPPY1, // 704 — alternate mapping
]);
const START_CODES = new Set([
  Btn.START,          // 315 — standard
  Btn.TRIGGER_HAPPY4, // 707 — ODROID-GO2/RK3326
  Btn.TRIGGER_HAPPY2, // 705 — alternate mapping
]);

// Abstract actions the app cares about
type Action = "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select" | "l1" | "r1" | "quit";

// Raw event for debug logging
interface RawEvent {
  device: string;
  type: number;
  code: number;
  value: number;
  time: number;
}

// Global event log for debug page
const EVENT_LOG: RawEvent[] = [];
const MAX_EVENT_LOG = 20;

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
  private deviceNames = new Map<ReturnType<typeof createReadStream>, string>();

  constructor(onAction: (action: Action) => void, onRelease: (action: Action) => void) {
    this.onAction = onAction;
    this.onRelease = onRelease;
  }

  start() {
    // Open ALL /dev/input/event* devices — don't filter by name,
    // because SELECT/START may live on an unexpected device
    const devices: string[] = [];
    try {
      const entries = readdirSync("/dev/input").sort();
      for (const entry of entries) {
        if (entry.startsWith("event")) {
          devices.push(`/dev/input/${entry}`);
        }
      }
    } catch {}

    if (devices.length === 0) {
      devices.push("/dev/input/event0");
    }

    for (const dev of devices) {
      try {
        // Log the device name from sysfs for debug visibility
        let devName = "?";
        try {
          const eventNum = dev.replace("/dev/input/", "");
          devName = readFileSync(
            `/sys/class/input/${eventNum}/device/name`,
            "utf8"
          ).trim();
        } catch {}

        const stream = createReadStream(dev, { highWaterMark: 24 * 64 });
        this.deviceNames.set(stream, dev);
        stream.on("data", (buf: Buffer) => this.parseEvents(buf, dev));
        stream.on("error", () => {}); // silently ignore devices we can't read
        this.streams.push(stream);
        console.log(`Input: ${dev} (${devName})`);
      } catch {}
    }
  }

  stop() {
    for (const s of this.streams) s.destroy();
    this.streams = [];
  }

  private parseEvents(buf: Buffer, device: string) {
    // struct input_event on 64-bit: 8(tv_sec) + 8(tv_usec) + 2(type) + 2(code) + 4(value) = 24 bytes
    const EVENT_SIZE = 24;
    for (let off = 0; off + EVENT_SIZE <= buf.length; off += EVENT_SIZE) {
      const type = buf.readUInt16LE(off + 16);
      const code = buf.readUInt16LE(off + 18);
      const value = buf.readInt32LE(off + 20);

      // Log all non-SYN events for debug page
      if (type !== 0) {
        logRawEvent({ device, type, code, value, time: Date.now() });
      }

      if (type === 1) {
        // EV_KEY — track held state for combos
        if (value === 1) {
          this.heldKeys.add(code);
          this.handleKey(code);
        } else if (value === 0) {
          this.heldKeys.delete(code);
          const action = this.codeToAction(code);
          if (action) this.onRelease(action);
        }
      } else if (type === 3) {
        // EV_ABS — d-pad hat
        if (code === 16) {
          // ABS_HAT0X
          if (value < 0) this.onAction("left");
          else if (value > 0) this.onAction("right");
        } else if (code === 17) {
          // ABS_HAT0Y
          if (value < 0) this.onAction("up");
          else if (value > 0) this.onAction("down");
        }
      }
    }
  }

  private isSelectCode(code: number): boolean {
    return SELECT_CODES.has(code);
  }

  private isStartCode(code: number): boolean {
    return START_CODES.has(code);
  }

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
    for (const code of SELECT_CODES) {
      if (this.heldKeys.has(code)) return true;
    }
    return false;
  }

  private isAnyStartHeld(): boolean {
    for (const code of START_CODES) {
      if (this.heldKeys.has(code)) return true;
    }
    return false;
  }

  private handleKey(code: number) {
    // Check SELECT+START combo (either order) at evdev level
    // Uses all known codes for select/start across R36S variants
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
// Keyboard fallback (for --dry-run / SSH debugging)
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
    else if (key === "q" || key === "\x03") onAction("quit"); // q or Ctrl+C = exit
    else if (key === "[" || key === ",") onAction("l1");
    else if (key === "]" || key === ".") onAction("r1");
  });
}

// ============================================================================
// 8x8 Bitmap Font (ASCII 32-126)
// ============================================================================
const FONT_8X8: number[][] = buildFont();

function buildFont(): number[][] {
  const raw: Record<number, number[]> = {
    32: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    33: [0x18, 0x18, 0x18, 0x18, 0x18, 0x00, 0x18, 0x00],
    34: [0x6c, 0x6c, 0x24, 0x00, 0x00, 0x00, 0x00, 0x00],
    35: [0x6c, 0xfe, 0x6c, 0x6c, 0xfe, 0x6c, 0x00, 0x00],
    36: [0x18, 0x7e, 0xc0, 0x7c, 0x06, 0xfc, 0x18, 0x00],
    37: [0xc6, 0xcc, 0x18, 0x30, 0x66, 0xc6, 0x00, 0x00],
    38: [0x38, 0x6c, 0x38, 0x76, 0xdc, 0xcc, 0x76, 0x00],
    39: [0x18, 0x18, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00],
    40: [0x0c, 0x18, 0x30, 0x30, 0x30, 0x18, 0x0c, 0x00],
    41: [0x30, 0x18, 0x0c, 0x0c, 0x0c, 0x18, 0x30, 0x00],
    42: [0x00, 0x66, 0x3c, 0xff, 0x3c, 0x66, 0x00, 0x00],
    43: [0x00, 0x18, 0x18, 0x7e, 0x18, 0x18, 0x00, 0x00],
    44: [0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x18, 0x30],
    45: [0x00, 0x00, 0x00, 0x7e, 0x00, 0x00, 0x00, 0x00],
    46: [0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x18, 0x00],
    47: [0x06, 0x0c, 0x18, 0x30, 0x60, 0xc0, 0x00, 0x00],
    48: [0x7c, 0xce, 0xde, 0xf6, 0xe6, 0xc6, 0x7c, 0x00],
    49: [0x18, 0x38, 0x18, 0x18, 0x18, 0x18, 0x7e, 0x00],
    50: [0x7c, 0xc6, 0x06, 0x1c, 0x70, 0xc6, 0xfe, 0x00],
    51: [0x7c, 0xc6, 0x06, 0x3c, 0x06, 0xc6, 0x7c, 0x00],
    52: [0x1c, 0x3c, 0x6c, 0xcc, 0xfe, 0x0c, 0x0c, 0x00],
    53: [0xfe, 0xc0, 0xfc, 0x06, 0x06, 0xc6, 0x7c, 0x00],
    54: [0x3c, 0x60, 0xc0, 0xfc, 0xc6, 0xc6, 0x7c, 0x00],
    55: [0xfe, 0xc6, 0x0c, 0x18, 0x30, 0x30, 0x30, 0x00],
    56: [0x7c, 0xc6, 0xc6, 0x7c, 0xc6, 0xc6, 0x7c, 0x00],
    57: [0x7c, 0xc6, 0xc6, 0x7e, 0x06, 0x0c, 0x78, 0x00],
    58: [0x00, 0x18, 0x18, 0x00, 0x00, 0x18, 0x18, 0x00],
    59: [0x00, 0x18, 0x18, 0x00, 0x00, 0x18, 0x18, 0x30],
    60: [0x0c, 0x18, 0x30, 0x60, 0x30, 0x18, 0x0c, 0x00],
    61: [0x00, 0x00, 0x7e, 0x00, 0x7e, 0x00, 0x00, 0x00],
    62: [0x60, 0x30, 0x18, 0x0c, 0x18, 0x30, 0x60, 0x00],
    63: [0x7c, 0xc6, 0x0c, 0x18, 0x18, 0x00, 0x18, 0x00],
    64: [0x7c, 0xc6, 0xde, 0xde, 0xdc, 0xc0, 0x7c, 0x00],
    65: [0x38, 0x6c, 0xc6, 0xc6, 0xfe, 0xc6, 0xc6, 0x00],
    66: [0xfc, 0xc6, 0xc6, 0xfc, 0xc6, 0xc6, 0xfc, 0x00],
    67: [0x7c, 0xc6, 0xc0, 0xc0, 0xc0, 0xc6, 0x7c, 0x00],
    68: [0xf8, 0xcc, 0xc6, 0xc6, 0xc6, 0xcc, 0xf8, 0x00],
    69: [0xfe, 0xc0, 0xc0, 0xfc, 0xc0, 0xc0, 0xfe, 0x00],
    70: [0xfe, 0xc0, 0xc0, 0xfc, 0xc0, 0xc0, 0xc0, 0x00],
    71: [0x7c, 0xc6, 0xc0, 0xce, 0xc6, 0xc6, 0x7e, 0x00],
    72: [0xc6, 0xc6, 0xc6, 0xfe, 0xc6, 0xc6, 0xc6, 0x00],
    73: [0x7e, 0x18, 0x18, 0x18, 0x18, 0x18, 0x7e, 0x00],
    74: [0x1e, 0x06, 0x06, 0x06, 0xc6, 0xc6, 0x7c, 0x00],
    75: [0xc6, 0xcc, 0xd8, 0xf0, 0xd8, 0xcc, 0xc6, 0x00],
    76: [0xc0, 0xc0, 0xc0, 0xc0, 0xc0, 0xc0, 0xfe, 0x00],
    77: [0xc6, 0xee, 0xfe, 0xd6, 0xc6, 0xc6, 0xc6, 0x00],
    78: [0xc6, 0xe6, 0xf6, 0xde, 0xce, 0xc6, 0xc6, 0x00],
    79: [0x7c, 0xc6, 0xc6, 0xc6, 0xc6, 0xc6, 0x7c, 0x00],
    80: [0xfc, 0xc6, 0xc6, 0xfc, 0xc0, 0xc0, 0xc0, 0x00],
    81: [0x7c, 0xc6, 0xc6, 0xc6, 0xd6, 0xde, 0x7c, 0x06],
    82: [0xfc, 0xc6, 0xc6, 0xfc, 0xd8, 0xcc, 0xc6, 0x00],
    83: [0x7c, 0xc6, 0xc0, 0x7c, 0x06, 0xc6, 0x7c, 0x00],
    84: [0x7e, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x00],
    85: [0xc6, 0xc6, 0xc6, 0xc6, 0xc6, 0xc6, 0x7c, 0x00],
    86: [0xc6, 0xc6, 0xc6, 0xc6, 0x6c, 0x38, 0x10, 0x00],
    87: [0xc6, 0xc6, 0xc6, 0xd6, 0xfe, 0xee, 0xc6, 0x00],
    88: [0xc6, 0x6c, 0x38, 0x38, 0x6c, 0xc6, 0xc6, 0x00],
    89: [0x66, 0x66, 0x66, 0x3c, 0x18, 0x18, 0x18, 0x00],
    90: [0xfe, 0x0c, 0x18, 0x30, 0x60, 0xc0, 0xfe, 0x00],
    91: [0x3c, 0x30, 0x30, 0x30, 0x30, 0x30, 0x3c, 0x00],
    92: [0xc0, 0x60, 0x30, 0x18, 0x0c, 0x06, 0x00, 0x00],
    93: [0x3c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x3c, 0x00],
    94: [0x10, 0x38, 0x6c, 0xc6, 0x00, 0x00, 0x00, 0x00],
    95: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfe],
    96: [0x30, 0x18, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00],
    97: [0x00, 0x00, 0x7c, 0x06, 0x7e, 0xc6, 0x7e, 0x00],
    98: [0xc0, 0xc0, 0xfc, 0xc6, 0xc6, 0xc6, 0xfc, 0x00],
    99: [0x00, 0x00, 0x7c, 0xc6, 0xc0, 0xc6, 0x7c, 0x00],
    100: [0x06, 0x06, 0x7e, 0xc6, 0xc6, 0xc6, 0x7e, 0x00],
    101: [0x00, 0x00, 0x7c, 0xc6, 0xfe, 0xc0, 0x7c, 0x00],
    102: [0x1c, 0x36, 0x30, 0x7c, 0x30, 0x30, 0x30, 0x00],
    103: [0x00, 0x00, 0x7e, 0xc6, 0xc6, 0x7e, 0x06, 0x7c],
    104: [0xc0, 0xc0, 0xfc, 0xc6, 0xc6, 0xc6, 0xc6, 0x00],
    105: [0x18, 0x00, 0x38, 0x18, 0x18, 0x18, 0x3c, 0x00],
    106: [0x06, 0x00, 0x06, 0x06, 0x06, 0x06, 0xc6, 0x7c],
    107: [0xc0, 0xc0, 0xcc, 0xd8, 0xf0, 0xd8, 0xcc, 0x00],
    108: [0x38, 0x18, 0x18, 0x18, 0x18, 0x18, 0x3c, 0x00],
    109: [0x00, 0x00, 0xec, 0xfe, 0xd6, 0xc6, 0xc6, 0x00],
    110: [0x00, 0x00, 0xfc, 0xc6, 0xc6, 0xc6, 0xc6, 0x00],
    111: [0x00, 0x00, 0x7c, 0xc6, 0xc6, 0xc6, 0x7c, 0x00],
    112: [0x00, 0x00, 0xfc, 0xc6, 0xc6, 0xfc, 0xc0, 0xc0],
    113: [0x00, 0x00, 0x7e, 0xc6, 0xc6, 0x7e, 0x06, 0x06],
    114: [0x00, 0x00, 0xdc, 0xe6, 0xc0, 0xc0, 0xc0, 0x00],
    115: [0x00, 0x00, 0x7e, 0xc0, 0x7c, 0x06, 0xfc, 0x00],
    116: [0x30, 0x30, 0x7c, 0x30, 0x30, 0x36, 0x1c, 0x00],
    117: [0x00, 0x00, 0xc6, 0xc6, 0xc6, 0xc6, 0x7e, 0x00],
    118: [0x00, 0x00, 0xc6, 0xc6, 0xc6, 0x6c, 0x38, 0x00],
    119: [0x00, 0x00, 0xc6, 0xc6, 0xd6, 0xfe, 0x6c, 0x00],
    120: [0x00, 0x00, 0xc6, 0x6c, 0x38, 0x6c, 0xc6, 0x00],
    121: [0x00, 0x00, 0xc6, 0xc6, 0xc6, 0x7e, 0x06, 0x7c],
    122: [0x00, 0x00, 0xfe, 0x0c, 0x38, 0x60, 0xfe, 0x00],
    123: [0x0e, 0x18, 0x18, 0x70, 0x18, 0x18, 0x0e, 0x00],
    124: [0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x00],
    125: [0x70, 0x18, 0x18, 0x0e, 0x18, 0x18, 0x70, 0x00],
    126: [0x76, 0xdc, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  };
  const result: number[][] = [];
  for (let i = 32; i <= 126; i++) {
    result[i - 32] = raw[i] ?? [0, 0, 0, 0, 0, 0, 0, 0];
  }
  return result;
}

// ============================================================================
// Framebuffer
// ============================================================================
class Framebuffer {
  width: number;
  height: number;
  bpp: number;
  buf: Buffer;
  fd: number | null = null;
  dryRun: boolean;

  constructor(dryRun = false) {
    this.dryRun = dryRun;
    this.width = 640;
    this.height = 480;
    this.bpp = 32;

    if (!dryRun) {
      try {
        const vsize = readFileSync(
          "/sys/class/graphics/fb0/virtual_size",
          "utf8"
        ).trim();
        const [w, h] = vsize.split(",").map(Number);
        if (w > 0 && h > 0) {
          this.width = w;
          this.height = h;
        }
      } catch {}
      try {
        const bpp = parseInt(
          readFileSync(
            "/sys/class/graphics/fb0/bits_per_pixel",
            "utf8"
          ).trim(),
          10
        );
        if (bpp > 0) this.bpp = bpp;
      } catch {}
    }

    this.buf = Buffer.alloc(this.width * this.height * (this.bpp / 8));

    if (!dryRun) {
      this.fd = openSync("/dev/fb0", "w");
    }

    console.log(
      `Framebuffer: ${this.width}x${this.height} @ ${this.bpp}bpp (${dryRun ? "dry-run" : "/dev/fb0"})`
    );
  }

  clear(color: number) {
    for (let i = 0; i < this.buf.length; i += 4) {
      this.buf.writeUInt32LE(color, i);
    }
  }

  setPixel(x: number, y: number, color: number) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.buf.writeUInt32LE(color, (y * this.width + x) * 4);
  }

  fillRect(x: number, y: number, w: number, h: number, color: number) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let py = y0; py < y1; py++) {
      const rowOff = py * this.width * 4;
      for (let px = x0; px < x1; px++) {
        this.buf.writeUInt32LE(color, rowOff + px * 4);
      }
    }
  }

  drawChar(x: number, y: number, ch: string, color: number, scale = 1) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return;
    const glyph = FONT_8X8[code - 32];
    for (let row = 0; row < 8; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 8; col++) {
        if (bits & (0x80 >> col)) {
          if (scale === 1) {
            this.setPixel(x + col, y + row, color);
          } else {
            this.fillRect(x + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
    }
  }

  drawText(x: number, y: number, text: string, color: number, scale = 1) {
    for (let i = 0; i < text.length; i++) {
      this.drawChar(x + i * 8 * scale, y, text[i], color, scale);
    }
  }

  drawHLine(x: number, y: number, w: number, color: number) {
    this.fillRect(x, y, w, 1, color);
  }

  drawVLine(x: number, y: number, h: number, color: number) {
    this.fillRect(x, y, 1, h, color);
  }

  drawRect(x: number, y: number, w: number, h: number, color: number) {
    this.drawHLine(x, y, w, color);
    this.drawHLine(x, y + h - 1, w, color);
    this.drawVLine(x, y, h, color);
    this.drawVLine(x + w - 1, y, h, color);
  }

  flush() {
    if (this.fd !== null) {
      writeSync(this.fd, this.buf, 0, this.buf.length, 0);
    }
  }

  close() {
    if (this.fd !== null) {
      this.clear(0xff000000);
      this.flush();
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

// ============================================================================
// System Stats
// ============================================================================
interface CpuTimes {
  idle: number;
  total: number;
}

function readCpuTimes(): CpuTimes {
  try {
    const stat = readFileSync("/proc/stat", "utf8");
    const line = stat.split("\n")[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] ?? 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return { idle: 0, total: 0 };
  }
}

function getCpuPercent(prev: CpuTimes, curr: CpuTimes): number {
  const dTotal = curr.total - prev.total;
  const dIdle = curr.idle - prev.idle;
  if (dTotal === 0) return 0;
  return Math.round(((dTotal - dIdle) / dTotal) * 100);
}

interface MemInfo {
  totalMB: number;
  usedMB: number;
  percent: number;
}

function getMemInfo(): MemInfo {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const get = (key: string) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? parseInt(m[1], 10) : 0;
    };
    const total = get("MemTotal");
    const free = get("MemFree");
    const buffers = get("Buffers");
    const cached = get("Cached");
    const used = total - free - buffers - cached;
    const totalMB = Math.round(total / 1024);
    const usedMB = Math.round(used / 1024);
    return { totalMB, usedMB, percent: Math.round((used / total) * 100) };
  } catch {
    const mem = process.memoryUsage();
    const usedMB = Math.round(mem.heapUsed / 1024 / 1024);
    return { totalMB: 0, usedMB, percent: 0 };
  }
}

function getUptime(): string {
  try {
    const raw = readFileSync("/proc/uptime", "utf8").trim();
    const secs = Math.floor(parseFloat(raw.split(" ")[0]));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h}h ${m}m ${s}s`;
  } catch {
    return "N/A";
  }
}

function getCpuTemp(): string {
  try {
    const raw = readFileSync(
      "/sys/class/thermal/thermal_zone0/temp",
      "utf8"
    ).trim();
    return `${(parseInt(raw, 10) / 1000).toFixed(1)}C`;
  } catch {
    return "N/A";
  }
}

function getDiskInfo(): string {
  try {
    const mounts = readFileSync("/proc/mounts", "utf8");
    const rootLine = mounts.split("\n").find((l) => l.includes(" / "));
    if (!rootLine) return "N/A";
    const device = rootLine.split(" ")[0];
    return device;
  } catch {
    return "N/A";
  }
}

function getLoadAvg(): string {
  try {
    const raw = readFileSync("/proc/loadavg", "utf8").trim();
    const parts = raw.split(" ");
    return `${parts[0]} ${parts[1]} ${parts[2]}`;
  } catch {
    return "N/A";
  }
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
// UI Helpers
// ============================================================================
function drawPanel(fb: Framebuffer, x: number, y: number, w: number, h: number) {
  fb.fillRect(x, y, w, h, COLOR.panelBg);
  fb.drawRect(x, y, w, h, COLOR.panelBorder);
}

// ============================================================================
// Page Renderers
// ============================================================================
function drawPageTabs(fb: Framebuffer, state: AppState, y: number): number {
  const W = fb.width;
  const margin = 32; // space for L1/R1 arrows
  const innerW = W - margin * 2;
  const tabW = Math.floor(innerW / PAGES.length);

  // L1/R1 arrow hints
  fb.drawText(4, y + 6, "<", COLOR.dimGray, 2);
  fb.drawText(12, y + 22, "L1", COLOR.dimGray, 1);
  fb.drawText(W - 20, y + 6, ">", COLOR.dimGray, 2);
  fb.drawText(W - 20, y + 22, "R1", COLOR.dimGray, 1);

  for (let i = 0; i < PAGES.length; i++) {
    const x = margin + i * tabW;
    const active = i === state.currentPage;
    const label = PAGES[i];
    const textX = x + Math.floor((tabW - label.length * 16) / 2);
    fb.drawText(textX, y + 6, label, active ? COLOR.white : COLOR.dimGray, 2);
    if (active) {
      // 3px accent underline
      fb.fillRect(x + 4, y + 26, tabW - 8, 3, COLOR.accentBlue);
    }
  }
  // Subtle separator below tabs
  fb.drawHLine(0, y + 32, W, COLOR.panelBorder);
  return y + 36;
}

function drawBar(
  fb: Framebuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  percent: number,
  label: string
) {
  fb.fillRect(x, y, w, h, COLOR.barBg);
  const fill = Math.round((Math.min(percent, 100) / 100) * w);
  const color =
    percent > 80 ? COLOR.red : percent > 50 ? COLOR.yellow : COLOR.barFill;
  fb.fillRect(x, y, fill, h, color);
  fb.drawRect(x, y, w, h, COLOR.panelBorder); // outline
  // Label at 2x inside bar, vertically centered
  const textY = y + Math.floor((h - 16) / 2);
  fb.drawText(x + 6, textY, label, COLOR.white, 2);
}

function renderStatusPage(
  fb: Framebuffer,
  state: AppState,
  mem: MemInfo,
  y: number
) {
  const W = fb.width;
  const pad = 16;
  const labelX = pad + 8;
  const barX = pad + 140;
  const barW = W - barX - pad - 8;
  const barH = 28;
  const lineH = 40;

  // CPU bar
  fb.drawText(labelX, y + 6, "CPU", COLOR.white, 2);
  drawBar(fb, barX, y, barW, barH, state.cpuPercent, `${state.cpuPercent}%`);
  y += lineH;

  // Memory bar
  fb.drawText(labelX, y + 6, "MEM", COLOR.white, 2);
  drawBar(fb, barX, y, barW, barH, mem.percent, `${mem.usedMB}/${mem.totalMB}MB`);
  y += lineH + 8;

  // Stats panel
  const panelX = pad;
  const panelW = W - pad * 2;
  const statsLineH = 30;
  const cpuTemp = getCpuTemp();
  const tempVal = parseFloat(cpuTemp);
  const stats = [
    { label: "CPU Temp", value: cpuTemp, color: tempVal > 70 ? COLOR.red : tempVal > 55 ? COLOR.yellow : COLOR.green },
    { label: "Load Avg", value: getLoadAvg(), color: COLOR.green },
    { label: "Uptime", value: getUptime(), color: COLOR.green },
    { label: "Heap", value: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, color: COLOR.green },
  ];
  const panelH = stats.length * statsLineH + 16;
  drawPanel(fb, panelX, y, panelW, panelH);

  let sy = y + 8;
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    // Alternate row shading
    if (i % 2 === 1) {
      fb.fillRect(panelX + 1, sy - 2, panelW - 2, statsLineH, COLOR.rowAlt);
    }
    // Colored dot indicator
    fb.fillRect(labelX, sy + 5, 6, 6, s.color);
    fb.drawText(labelX + 14, sy, s.label, COLOR.gray, 2);
    // Right-aligned value
    const valW = s.value.length * 16;
    fb.drawText(panelX + panelW - valW - 12, sy, s.value, COLOR.white, 2);
    sy += statsLineH;
  }
  y += panelH + 12;

  // Heartbeat spinner
  const spinChars = ["-", "\\", "|", "/"];
  const spin = spinChars[state.tick % spinChars.length];
  fb.drawText(labelX, y, `Heartbeat ${spin}`, COLOR.green, 2);
}

function renderSystemPage(fb: Framebuffer, y: number) {
  const W = fb.width;
  const pad = 16;
  const panelX = pad;
  const panelW = W - pad * 2;
  const labelX = panelX + 12;
  const lineH = 28;

  // Platform info panel
  const sysRows = [
    { label: "Platform", value: `${process.platform} ${process.arch}` },
    { label: "Runtime", value: `Bun ${process.version}` },
    { label: "PID", value: `${process.pid}` },
    { label: "Root Dev", value: getDiskInfo() },
    { label: "CWD", value: process.cwd() },
  ];
  const panelH1 = sysRows.length * lineH + 16;
  drawPanel(fb, panelX, y, panelW, panelH1);

  let sy = y + 8;
  for (let i = 0; i < sysRows.length; i++) {
    const r = sysRows[i];
    if (i % 2 === 1) {
      fb.fillRect(panelX + 1, sy - 2, panelW - 2, lineH, COLOR.rowAlt);
    }
    fb.drawText(labelX, sy, r.label, COLOR.gray, 2);
    const valW = r.value.length * 16;
    const maxValW = panelW - 200;
    const displayVal = valW > maxValW ? r.value.slice(0, Math.floor(maxValW / 16)) + ".." : r.value;
    fb.drawText(panelX + panelW - displayVal.length * 16 - 12, sy, displayVal, COLOR.white, 2);
    sy += lineH;
  }
  y += panelH1 + 12;

  // Environment panel
  fb.drawText(labelX, y, "Environment", COLOR.gray, 2);
  y += 24;
  const envKeys = ["HOME", "USER", "SHELL", "TERM", "DISPLAY"];
  const panelH2 = envKeys.length * lineH + 16;
  drawPanel(fb, panelX, y, panelW, panelH2);

  sy = y + 8;
  for (let i = 0; i < envKeys.length; i++) {
    const key = envKeys[i];
    const val = process.env[key] ?? "N/A";
    if (i % 2 === 1) {
      fb.fillRect(panelX + 1, sy - 2, panelW - 2, lineH, COLOR.rowAlt);
    }
    fb.drawText(labelX, sy, key, COLOR.cyan, 2);
    const displayVal = val.length > 24 ? val.slice(0, 22) + ".." : val;
    fb.drawText(panelX + panelW - displayVal.length * 16 - 12, sy, displayVal, COLOR.white, 2);
    sy += lineH;
  }
}

function renderDebugPage(fb: Framebuffer, state: AppState, y: number) {
  const W = fb.width;
  const pad = 16;
  const panelX = pad;
  const panelW = W - pad * 2;
  const labelX = panelX + 12;

  // Held state panel
  const heldPanelH = 48;
  drawPanel(fb, panelX, y, panelW, heldPanelH);
  fb.drawText(labelX, y + 8, "SELECT", COLOR.gray, 2);
  const selColor = state.selectHeld ? COLOR.green : COLOR.dimGray;
  fb.fillRect(labelX + 120, y + 10, 12, 12, selColor);
  fb.drawText(labelX + 140, y + 8, state.selectHeld ? "HELD" : "---", selColor, 2);

  fb.drawText(labelX + 260, y + 8, "START", COLOR.gray, 2);
  const startColor = state.startHeld ? COLOR.green : COLOR.dimGray;
  fb.fillRect(labelX + 360, y + 10, 12, 12, startColor);
  fb.drawText(labelX + 380, y + 8, state.startHeld ? "HELD" : "---", startColor, 2);
  y += heldPanelH + 8;

  // Raw event log
  fb.drawText(labelX, y, "Event Log", COLOR.gray, 2);
  y += 24;

  const rowH = 13;
  const maxRows = 18;
  const events = EVENT_LOG.slice().reverse();
  const logPanelH = Math.max(maxRows * rowH + 24, 60);
  drawPanel(fb, panelX, y, panelW, logPanelH);

  // Header row
  const hy = y + 6;
  fb.drawText(labelX, hy, "DEV", COLOR.dimGray, 1);
  fb.drawText(labelX + 80, hy, "TYPE", COLOR.dimGray, 1);
  fb.drawText(labelX + 140, hy, "CODE", COLOR.dimGray, 1);
  fb.drawText(labelX + 200, hy, "VALUE", COLOR.dimGray, 1);
  fb.drawHLine(panelX + 4, hy + 10, panelW - 8, COLOR.panelBorder);

  let ey = hy + 14;
  for (let i = 0; i < Math.min(events.length, maxRows); i++) {
    const ev = events[i];
    // Alternate row shading
    if (i % 2 === 1) {
      fb.fillRect(panelX + 1, ey - 1, panelW - 2, rowH, COLOR.rowAlt);
    }
    const devShort = ev.device.replace("/dev/input/", "");
    const typeName = ev.type === 1 ? "EV_KEY" : ev.type === 3 ? "EV_ABS" : `T=${ev.type}`;
    const valueName = ev.type === 1
      ? ev.value === 1 ? "PRESS" : ev.value === 0 ? "RELEASE" : "REPEAT"
      : String(ev.value);
    const color = ev.type === 1 && ev.value === 1 ? COLOR.green : COLOR.dimGray;
    fb.drawText(labelX, ey, devShort, color, 1);
    fb.drawText(labelX + 80, ey, typeName, color, 1);
    fb.drawText(labelX + 140, ey, String(ev.code), color, 1);
    fb.drawText(labelX + 200, ey, valueName, color, 1);
    ey += rowH;
  }

  if (events.length === 0) {
    fb.drawText(labelX, ey, "No events yet. Press any button.", COLOR.dimGray, 1);
  }
}

function renderAboutPage(fb: Framebuffer, y: number) {
  const W = fb.width;
  const pad = 16;
  const panelX = pad;
  const panelW = W - pad * 2;
  const labelX = panelX + 12;
  const lineH = 28;

  // Centered title
  const title = "R36S Panel 4 Dashboard";
  const titleW = title.length * 16;
  fb.drawText(Math.floor((W - titleW) / 2), y, title, COLOR.white, 2);
  y += 24;
  const verStr = `Version ${version}`;
  const verW = verStr.length * 16;
  fb.drawText(Math.floor((W - verW) / 2), y, verStr, COLOR.dimGray, 2);
  y += 20;
  // Accent bar
  fb.fillRect(Math.floor(W / 2) - 60, y, 120, 2, COLOR.accentBlue);
  y += 14;

  // Hardware specs panel
  fb.drawText(labelX, y, "Hardware", COLOR.gray, 2);
  y += 22;
  const specs = [
    { label: "SoC", value: "Rockchip RK3326" },
    { label: "Display", value: "640x480 BGRA 32bpp" },
    { label: "Runtime", value: "Bun (compiled ARM64)" },
  ];
  const specPanelH = specs.length * lineH + 16;
  drawPanel(fb, panelX, y, panelW, specPanelH);

  let sy = y + 8;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    if (i % 2 === 1) {
      fb.fillRect(panelX + 1, sy - 2, panelW - 2, lineH, COLOR.rowAlt);
    }
    fb.drawText(labelX, sy, s.label, COLOR.gray, 2);
    const valW = s.value.length * 16;
    fb.drawText(panelX + panelW - valW - 12, sy, s.value, COLOR.white, 2);
    sy += lineH;
  }
  y += specPanelH + 12;

  // Controls panel
  fb.drawText(labelX, y, "Controls", COLOR.gray, 2);
  y += 22;
  const controls = [
    { label: "L1 / R1", value: "Switch pages" },
    { label: "D-pad", value: "Navigate" },
    { label: "SEL+START", value: "Exit app" },
  ];
  const ctrlPanelH = controls.length * lineH + 16;
  drawPanel(fb, panelX, y, panelW, ctrlPanelH);

  sy = y + 8;
  for (let i = 0; i < controls.length; i++) {
    const c = controls[i];
    if (i % 2 === 1) {
      fb.fillRect(panelX + 1, sy - 2, panelW - 2, lineH, COLOR.rowAlt);
    }
    fb.drawText(labelX, sy, c.label, COLOR.cyan, 2);
    const valW = c.value.length * 16;
    fb.drawText(panelX + panelW - valW - 12, sy, c.value, COLOR.white, 2);
    sy += lineH;
  }
}

// ============================================================================
// Main Renderer
// ============================================================================
function render(fb: Framebuffer, state: AppState) {
  const W = fb.width;
  const mem = getMemInfo();

  // Update CPU
  const currCpu = readCpuTimes();
  state.cpuPercent = getCpuPercent(state.prevCpu, currCpu);
  state.prevCpu = currCpu;

  // Background
  fb.clear(COLOR.bg);

  // Header — 40px tall
  const headerH = 40;
  fb.fillRect(0, 0, W, headerH, COLOR.headerBg);
  fb.drawText(12, 12, `R36S Dashboard v${version}`, COLOR.white, 2);
  const timeStr = new Date().toLocaleTimeString();
  fb.drawText(W - timeStr.length * 16 - 12, 12, timeStr, COLOR.yellow, 2);
  // 2px accent line
  fb.fillRect(0, headerH, W, 2, COLOR.accentBlue);

  // Page tabs
  let y = drawPageTabs(fb, state, headerH + 4);
  y += 4;

  // Page content
  switch (PAGES[state.currentPage]) {
    case "Status":
      renderStatusPage(fb, state, mem, y);
      break;
    case "System":
      renderSystemPage(fb, y);
      break;
    case "Debug":
      renderDebugPage(fb, state, y);
      break;
    case "About":
      renderAboutPage(fb, y);
      break;
  }

  // Footer — 28px tall
  const footerH = 28;
  const footerY = fb.height - footerH;
  fb.fillRect(0, footerY, W, footerH, COLOR.footerBg);
  fb.drawHLine(0, footerY, W, COLOR.panelBorder);

  // Left: < L1
  fb.drawText(12, footerY + 6, "< L1", COLOR.dimGray, 2);
  // Center: SEL+START Exit + page indicator
  const centerText = "SEL+START Exit";
  const ctW = centerText.length * 16;
  fb.drawText(Math.floor((W - ctW) / 2), footerY + 6, centerText, COLOR.gray, 2);
  // Right: page indicator + R1 >
  const pageStr = `${state.currentPage + 1}/${PAGES.length}`;
  fb.drawText(W - 120, footerY + 6, pageStr, COLOR.dimGray, 2);
  fb.drawText(W - 60, footerY + 6, "R1 >", COLOR.dimGray, 2);

  fb.flush();
  state.tick++;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const fb = new Framebuffer(dryRun);

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

  const shutdown = () => {
    state.running = false;
    input.stop();
    fb.close();
    showVtCursor();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {}
    }
    console.log("Exiting.");
    process.exit(0);
  };

  // Render loop — immediate render on input, periodic refresh for stats
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRender = () => {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(scheduleRender, 1000);
    if (!state.running) return;
    render(fb, state);
    state.dirty = false;
  };

  const handleAction = (action: Action) => {
    // Track select/start held at action level for combo detection
    if (action === "select") {
      state.selectHeld = true;
      // Check combo: if start is already held, quit
      if (state.startHeld) { shutdown(); return; }
      state.dirty = true;
      scheduleRender();
      return;
    }
    if (action === "start") {
      state.startHeld = true;
      // Check combo: if select is already held, quit
      if (state.selectHeld) { shutdown(); return; }
      state.dirty = true;
      scheduleRender();
      return;
    }

    if (action === "quit") {
      shutdown();
      return;
    }

    switch (action) {
      case "left":
      case "l1":
        state.currentPage =
          (state.currentPage - 1 + PAGES.length) % PAGES.length;
        state.dirty = true;
        break;
      case "right":
      case "r1":
        state.currentPage = (state.currentPage + 1) % PAGES.length;
        state.dirty = true;
        break;
      default:
        // On Debug page, re-render on any input to show live events
        if (PAGES[state.currentPage] === "Debug") {
          state.dirty = true;
        }
        break;
    }
    if (state.dirty) scheduleRender();
  };

  // Input setup
  const handleRelease = (action: Action) => {
    if (action === "select") state.selectHeld = false;
    if (action === "start") state.startHeld = false;
    // Re-render debug page on release events too
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

  hideVtCursor();
  console.log("Dashboard running. Press SELECT+START to exit.");

  scheduleRender(); // first frame + start periodic refresh
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
