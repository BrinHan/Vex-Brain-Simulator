import { BLACK, VexColor, WHITE, toColor } from './color';

/** The subset of CanvasRenderingContext2D the Brain screen needs (lets tests use a recording mock). */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** Marker for python keyword arguments passed to library functions. */
export class Kw {
  constructor(public o: Record<string, unknown>) {}
}

export const SCREEN_W = 480;
export const SCREEN_H = 240;

interface FontInfo { h: number; w: number; mono: boolean }
const FONTS: Record<string, FontInfo> = {
  mono12: { h: 12, w: 6, mono: true },
  mono15: { h: 15, w: 7.5, mono: true },
  mono20: { h: 20, w: 10, mono: true }, // 12 rows x 48 columns, the V5 default
  mono30: { h: 30, w: 15, mono: true },
  mono40: { h: 40, w: 20, mono: true },
  mono60: { h: 60, w: 30, mono: true },
  prop20: { h: 20, w: 10, mono: false },
  prop30: { h: 30, w: 15, mono: false },
  prop40: { h: 40, w: 20, mono: false },
  prop60: { h: 60, w: 30, mono: false },
};
// fraction of the line height above the baseline; printAt's y coordinate is treated as the text baseline
const ASCENT = 0.8;

/** Fill missing positional args from a trailing python Kw object using the given parameter names. */
function bind(args: unknown[], names: string[]): unknown[] {
  const last = args[args.length - 1];
  if (!(last instanceof Kw)) return args;
  const out = args.slice(0, -1);
  names.forEach((n, i) => { if (n in last.o) out[i] = last.o[n]; });
  return out;
}

function fmtNum(n: number, precision?: number): string {
  if (Number.isInteger(n)) return String(n);
  return precision === undefined ? String(n) : n.toFixed(precision);
}

export class BrainScreen {
  penColor: VexColor = WHITE;
  fillColor: VexColor = BLACK;
  penWidth = 1;
  fontName = 'mono20';
  originX = 0;
  originY = 0;
  curX = 0;
  curY = 0;
  /** true while a Python program runs: print/printAt use Python argument conventions */
  pythonMode = false;
  touching = false;
  touchX = 0;
  touchY = 0;
  private warnedFonts = new Set<string>();
  private pressedCbs: unknown[] = [];
  private releasedCbs: unknown[] = [];
  /** Injected by the runtime: starts a user callback as its own concurrent task. */
  spawn: (fn: unknown, args?: unknown[]) => void = () => {};
  /** Injected: formats printf-style strings (shared with the C helpers). */
  sprintf: (fmt: string, args: unknown[]) => string = (f) => f;
  warn: (msg: string) => void = () => {};

  constructor(private ctx: Ctx2D) {
    this.reset();
  }

  /** Back to power-on state: black screen, white pen, mono20, cursor at 1,1. */
  reset(): void {
    this.penColor = WHITE;
    this.fillColor = BLACK;
    this.penWidth = 1;
    this.fontName = 'mono20';
    this.originX = 0;
    this.originY = 0;
    this.curX = 0;
    this.curY = 0;
    this.touching = false;
    this.pressedCbs = [];
    this.releasedCbs = [];
    this.warnedFonts.clear();
    this.fillAll(BLACK);
  }

  private font(): FontInfo { return FONTS[this.fontName] ?? FONTS.mono20; }

  private fillAll(c: VexColor): void {
    this.ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    if (!c.transparent) {
      this.ctx.fillStyle = c.css();
      this.ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    }
  }

  // ---------------------------------------------------------------- settings
  setPenColor(c: unknown): void { this.penColor = toColor(c, this.penColor); }
  setFillColor(c: unknown): void { this.fillColor = toColor(c, this.fillColor); }
  setPenWidth(w: unknown): void { this.penWidth = Math.max(0, Number(w) || 0); }
  setFont(f: unknown): void {
    const n = String(f).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FONTS[n]) this.fontName = n;
    else if (!this.warnedFonts.has(n)) {
      this.warnedFonts.add(n); // once per unknown value, not once per call
      this.warn(`Unknown font '${String(f)}', keeping ${this.fontName}`);
    }
  }
  setOrigin(x: unknown, y: unknown): void { this.originX = Number(x) || 0; this.originY = Number(y) || 0; }

  // ---------------------------------------------------------------- clearing / cursor
  clearScreen(color?: unknown): void {
    const [c] = bind([color], ['color']);
    this.fillAll(c === undefined ? BLACK : toColor(c, BLACK));
    this.curX = 0;
    this.curY = 0;
  }

  clearLine(a?: unknown, b?: unknown): void {
    const f = this.font();
    let row: number | undefined;
    let color: unknown;
    if (typeof a === 'number') { row = a; color = b; } else if (a instanceof Kw) { row = a.o.row as number | undefined; color = a.o.color; } else color = a;
    const y = row !== undefined ? (row - 1) * f.h : this.curY;
    const c = color === undefined ? BLACK : toColor(color, BLACK);
    if (!c.transparent) {
      this.ctx.fillStyle = c.css();
      this.ctx.fillRect(0, y, SCREEN_W, f.h);
    }
    this.curX = 0;
    if (row !== undefined) this.curY = y;
  }

  setCursor(row: unknown, col: unknown): void {
    const [r, c] = bind([row, col], ['row', 'col']);
    const f = this.font();
    this.curY = (Number(r) - 1) * f.h;
    this.curX = (Number(c) - 1) * f.w;
  }
  row(): number { return Math.floor(this.curY / this.font().h) + 1; }
  column(): number { return Math.floor(this.curX / this.font().w) + 1; }
  newLine(): void { this.curX = 0; this.curY += this.font().h; }

  // ---------------------------------------------------------------- shapes
  drawPixel(x: unknown, y: unknown): void {
    const [px, py] = bind([x, y], ['x', 'y']) as number[];
    if (this.penColor.transparent) return;
    this.ctx.fillStyle = this.penColor.css();
    this.ctx.fillRect(px + this.originX, py + this.originY, 1, 1);
  }

  drawLine(x1: unknown, y1: unknown, x2: unknown, y2: unknown): void {
    const [a, b, c, d] = bind([x1, y1, x2, y2], ['x1', 'y1', 'x2', 'y2']) as number[];
    if (this.penColor.transparent || this.penWidth <= 0) return;
    const ctx = this.ctx;
    ctx.strokeStyle = this.penColor.css();
    ctx.lineWidth = this.penWidth;
    ctx.beginPath();
    ctx.moveTo(a + this.originX + 0.5, b + this.originY + 0.5);
    ctx.lineTo(c + this.originX + 0.5, d + this.originY + 0.5);
    ctx.stroke();
  }

  drawRectangle(x: unknown, y: unknown, w: unknown, h: unknown, color?: unknown): void {
    const [px, py, pw, ph, col] = bind([x, y, w, h, color], ['x', 'y', 'width', 'height', 'color']) as number[];
    const fill = col === undefined ? this.fillColor : toColor(col, this.fillColor);
    const rx = px + this.originX;
    const ry = py + this.originY;
    if (!fill.transparent) {
      this.ctx.fillStyle = fill.css();
      this.ctx.fillRect(rx, ry, pw, ph);
    }
    if (!this.penColor.transparent && this.penWidth > 0) {
      this.ctx.strokeStyle = this.penColor.css();
      this.ctx.lineWidth = this.penWidth;
      this.ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(pw - 1, 0), Math.max(ph - 1, 0));
    }
  }

  drawCircle(x: unknown, y: unknown, r: unknown, color?: unknown): void {
    const [px, py, pr, col] = bind([x, y, r, color], ['x', 'y', 'radius', 'color']) as number[];
    const fill = col === undefined ? this.fillColor : toColor(col, this.fillColor);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(px + this.originX + 0.5, py + this.originY + 0.5, Math.max(pr, 0), 0, Math.PI * 2);
    if (!fill.transparent) { ctx.fillStyle = fill.css(); ctx.fill(); }
    if (!this.penColor.transparent && this.penWidth > 0) {
      ctx.strokeStyle = this.penColor.css();
      ctx.lineWidth = this.penWidth;
      ctx.stroke();
    }
  }

  drawImageFromFile(name: unknown): void {
    this.warn(`drawImageFromFile("${String(name)}") is not supported in the simulator - images need an SD card`);
  }

  // ---------------------------------------------------------------- text
  private fontCss(f: FontInfo): string {
    return f.mono
      ? `${Math.round(f.h * 0.83)}px "Courier New", Consolas, monospace`
      : `${Math.round(f.h * 0.8)}px Arial, Helvetica, sans-serif`;
  }

  private charWidth(ch: string, f: FontInfo): number {
    if (f.mono) return f.w;
    this.ctx.font = this.fontCss(f);
    return this.ctx.measureText(ch).width;
  }

  getStringWidth(s: unknown): number {
    const f = this.font();
    let w = 0;
    for (const ch of String(s)) w += this.charWidth(ch, f);
    return Math.round(w);
  }
  getStringHeight(): number { return this.font().h; }

  /** Draw `text` with its box top-left at (x, top); returns the x after the last glyph. */
  private drawText(text: string, x: number, top: number, opaque: boolean): number {
    const f = this.font();
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const ch of text) {
      const w = this.charWidth(ch, f);
      if (opaque && !this.fillColor.transparent) {
        ctx.fillStyle = this.fillColor.css();
        ctx.fillRect(Math.round(x), top, Math.ceil(w), f.h);
      }
      if (ch !== ' ' && !this.penColor.transparent) {
        ctx.font = this.fontCss(f);
        ctx.fillStyle = this.penColor.css();
        const gx = f.mono ? x + (w - ctx.measureText(ch).width) / 2 : x;
        ctx.fillText(ch, gx, top + Math.round(f.h * ASCENT));
      }
      x += w;
    }
    return x;
  }

  /** Converts print arguments to text. C++: printf-style when the first arg is a string. Python: join with sep. */
  private format(args: unknown[], python: boolean, sep: string, precision: number): string {
    if (python) return args.map((a) => (typeof a === 'number' ? fmtNum(a, precision) : this.pyStr(a))).join(sep);
    if (typeof args[0] === 'string') return this.sprintf(args[0], args.slice(1));
    return args.map((a) => (typeof a === 'boolean' ? (a ? '1' : '0') : String(a))).join(sep);
  }

  private pyStr(a: unknown): string {
    if (a === true) return 'True';
    if (a === false) return 'False';
    if (a === null || a === undefined) return 'None';
    return String(a);
  }

  print(...args: unknown[]): void {
    const last = args[args.length - 1];
    const python = last instanceof Kw;
    const kw = python ? (last as Kw).o : {};
    const pos = python ? args.slice(0, -1) : args;
    const text = this.format(pos, python, String(kw.sep ?? ' '), Number(kw.precision ?? 2));
    this.emit(text);
  }

  /** Python print() with no kwargs still gets python formatting; detect via flag set by the python alias. */
  printPy(...args: unknown[]): void {
    const last = args[args.length - 1];
    const kw = last instanceof Kw ? last.o : {};
    const pos = last instanceof Kw ? args.slice(0, -1) : args;
    this.emit(this.format(pos, true, String(kw.sep ?? ' '), Number(kw.precision ?? 2)));
  }

  private emit(text: string): void {
    const f = this.font();
    const lines = text.split('\n');
    lines.forEach((ln, i) => {
      if (i > 0) this.newLine();
      this.curX = this.drawText(ln, this.curX + this.originX, this.curY + this.originY, true) - this.originX;
    });
    void f;
  }

  printAt(...args: unknown[]): void { this.printAtImpl(args, false); }
  printAtPy(...args: unknown[]): void { this.printAtImpl(args, true); }

  private printAtImpl(args: unknown[], python: boolean): void {
    const f = this.font();
    let x: number;
    let y: number;
    let opaque = false;
    let text: string;
    if (python) {
      const last = args[args.length - 1];
      const kw = last instanceof Kw ? last.o : {};
      const pos = last instanceof Kw ? args.slice(0, -1) : args;
      x = Number(kw.x ?? 0);
      y = Number(kw.y ?? 0);
      opaque = !!kw.opaque;
      text = this.format(pos, true, String(kw.sep ?? ' '), Number(kw.precision ?? 2));
    } else {
      x = Number(args[0]);
      y = Number(args[1]);
      let rest = args.slice(2);
      if (typeof rest[0] === 'boolean') { opaque = rest[0]; rest = rest.slice(1); }
      text = this.format(rest, false, ' ', 2);
    }
    const top = Math.round(y - f.h * ASCENT) + this.originY;
    let cx = x + this.originX;
    text.split('\n').forEach((ln, i) => {
      cx = this.drawText(ln, i === 0 ? cx : x + this.originX, top + i * f.h, opaque);
    });
  }

  // ---------------------------------------------------------------- touch
  pressing(): boolean { return this.touching; }
  xPosition(): number { return this.touching || this.touchX ? Math.round(this.touchX) : 0; }
  yPosition(): number { return this.touching || this.touchY ? Math.round(this.touchY) : 0; }
  pressed(cb: unknown): void { this.pressedCbs.push(cb); }
  released(cb: unknown): void { this.releasedCbs.push(cb); }
  render(): void {}
  waitForRender(): void {}

  touchDown(x: number, y: number): void {
    this.touching = true;
    this.touchX = Math.max(0, Math.min(SCREEN_W - 1, x));
    this.touchY = Math.max(0, Math.min(SCREEN_H - 1, y));
    this.pressedCbs.forEach((cb) => this.spawn(cb));
  }
  touchMove(x: number, y: number): void {
    if (!this.touching) return;
    this.touchX = Math.max(0, Math.min(SCREEN_W - 1, x));
    this.touchY = Math.max(0, Math.min(SCREEN_H - 1, y));
  }
  touchUp(): void {
    if (!this.touching) return;
    this.touching = false;
    this.releasedCbs.forEach((cb) => this.spawn(cb));
  }
}

const SNAKE: Record<string, string> = {
  clear_screen: 'clearScreen', clear_row: 'clearLine', set_cursor: 'setCursor', next_row: 'newLine', new_line: 'newLine',
  set_pen_width: 'setPenWidth', set_pen_color: 'setPenColor', set_fill_color: 'setFillColor', set_font: 'setFont',
  set_origin: 'setOrigin', draw_pixel: 'drawPixel', draw_line: 'drawLine', draw_rectangle: 'drawRectangle',
  draw_circle: 'drawCircle', draw_image_from_file: 'drawImageFromFile', get_string_width: 'getStringWidth',
  get_string_height: 'getStringHeight', x_position: 'xPosition', y_position: 'yPosition', wait_for_render: 'waitForRender',
};

/** The object scripts see as Brain.Screen / brain.screen: camelCase (C++) plus snake_case (Python) names. */
export function screenApi(screen: BrainScreen): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  const bindFn = (name: string): unknown => (screen as unknown as Record<string, (...a: unknown[]) => unknown>)[name].bind(screen);
  for (const n of [
    'clearScreen', 'clearLine', 'setCursor', 'row', 'column', 'newLine', 'setPenWidth', 'setPenColor', 'setFillColor', 'setFont',
    'setOrigin', 'drawPixel', 'drawLine', 'drawRectangle', 'drawCircle', 'drawImageFromFile', 'getStringWidth', 'getStringHeight',
    'pressing', 'xPosition', 'yPosition', 'pressed', 'released', 'render', 'waitForRender',
  ]) api[n] = bindFn(n);
  api.print = bindFn('print');
  api.printAt = bindFn('printAt');
  for (const [snake, camel] of Object.entries(SNAKE)) api[snake] = api[camel];
  // python flavoured text output
  api.print = (...a: unknown[]) => (screen.pythonMode ? screen.printPy(...a) : screen.print(...a));
  api.print_at = bindFn('printAtPy');
  api.printAt = (...a: unknown[]) => (screen.pythonMode ? screen.printAtPy(...a) : screen.printAt(...a));
  return api;
}
