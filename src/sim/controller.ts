// The V5 controller: live input (driven by the keyboard or a gamepad in the UI) and the API programs use to read it.

export const BUTTONS = ['L1', 'L2', 'R1', 'R2', 'Up', 'Down', 'Left', 'Right', 'X', 'B', 'Y', 'A'] as const;
export type ButtonName = (typeof BUTTONS)[number];
export const AXES = [1, 2, 3, 4] as const;
export type AxisNumber = (typeof AXES)[number];

/** The controller screen is 3 rows of 19 characters. */
const CTRL_ROWS = 3;
const CTRL_COLS = 19;

type InputEvent = { type: 'pressed' | 'released'; button: ButtonName } | { type: 'axis'; axis: AxisNumber };

/** Stick and button state, shared by the UI that changes it and the program that reads it. Positions are percent. */
export class ControllerInput {
  readonly axes: Record<AxisNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  readonly held = new Set<ButtonName>();
  private subs = new Set<(e: InputEvent) => void>();

  setButton(b: ButtonName, down: boolean): void {
    if (down === this.held.has(b)) return;
    if (down) this.held.add(b);
    else this.held.delete(b);
    this.emit({ type: down ? 'pressed' : 'released', button: b });
  }

  setAxis(n: AxisNumber, v: number): void {
    const p = Math.max(-100, Math.min(100, Math.round(v)));
    if (this.axes[n] === p) return;
    this.axes[n] = p;
    this.emit({ type: 'axis', axis: n });
  }

  releaseAll(): void {
    for (const b of [...this.held]) this.setButton(b, false);
    for (const n of AXES) this.setAxis(n, 0);
  }

  subscribe(fn: (e: InputEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(e: InputEvent): void {
    for (const fn of this.subs) fn(e);
  }
}

/** Text written with Controller.Screen: a 3 x 19 character grid with a 1-based cursor. */
export class ControllerScreen {
  rows: string[] = Array(CTRL_ROWS).fill('');
  row = 1;
  col = 1;
  onChange: (rows: string[]) => void = () => {};

  print(text: string): void {
    for (const ch of text) {
      if (ch === '\n') { this.newLine(); continue; }
      if (this.row < 1 || this.row > CTRL_ROWS || this.col > CTRL_COLS) continue;
      const r = this.rows[this.row - 1].padEnd(this.col - 1, ' ');
      this.rows[this.row - 1] = r.slice(0, this.col - 1) + ch + r.slice(this.col);
      this.col++;
    }
    this.onChange(this.rows);
  }
  setCursor(row: number, col: number): void { this.row = Math.trunc(row); this.col = Math.max(1, Math.trunc(col)); }
  newLine(): void { this.row++; this.col = 1; }
  clearScreen(): void { this.rows = Array(CTRL_ROWS).fill(''); this.row = 1; this.col = 1; this.onChange(this.rows); }
  clearLine(row?: number): void {
    const r = row === undefined ? this.row : Math.trunc(row);
    if (r >= 1 && r <= CTRL_ROWS) this.rows[r - 1] = '';
    this.col = 1;
    this.onChange(this.rows);
  }
}

const PY_SCREEN_NAMES: Record<string, string> = {
  set_cursor: 'setCursor', clear_screen: 'clearScreen', clear_line: 'clearLine', clear_row: 'clearLine', new_line: 'newLine', next_row: 'newLine',
};

export interface ControllerHost {
  spawn(fn: unknown, args?: unknown[]): void;
  format(args: unknown[]): string; // C++ printf-style or Python print-style text for Screen.print
}

/**
 * Builds the program-facing controller object with both naming styles: C++ (`Axis3`, `ButtonL1`, `Screen.setCursor`)
 * and Python (`axis3`, `buttonL1`, `screen.set_cursor`). Returns it with a function that removes its callbacks.
 */
export function createController(input: ControllerInput, screen: ControllerScreen, host: ControllerHost): { api: any; dispose: () => void } {
  const onPress = new Map<ButtonName, unknown[]>();
  const onRelease = new Map<ButtonName, unknown[]>();
  const onAxis = new Map<AxisNumber, unknown[]>();
  const add = <K>(m: Map<K, unknown[]>, k: K, fn: unknown): void => { m.set(k, [...(m.get(k) ?? []), fn]); };

  const dispose = input.subscribe((e) => {
    const fns = e.type === 'axis' ? onAxis.get(e.axis) : (e.type === 'pressed' ? onPress : onRelease).get(e.button);
    for (const fn of fns ?? []) host.spawn(fn);
  });

  const api: Record<string, any> = {
    installed: () => true,
    rumble: () => {},
    timestamp: () => 0,
  };
  for (const n of AXES) {
    const axis = {
      position: () => input.axes[n],
      value: () => Math.round((input.axes[n] * 127) / 100),
      changed: (fn: unknown) => add(onAxis, n, fn),
    };
    api[`Axis${n}`] = axis;
    api[`axis${n}`] = axis;
  }
  for (const b of BUTTONS) {
    const button = {
      pressing: () => input.held.has(b),
      pressed: (fn: unknown) => add(onPress, b, fn),
      released: (fn: unknown) => add(onRelease, b, fn),
    };
    api[`Button${b}`] = button;
    api[`button${b}`] = button;
  }
  const scr: Record<string, unknown> = {
    print: (...a: unknown[]) => screen.print(host.format(a)),
    setCursor: (r: number, c: number) => screen.setCursor(r, c),
    clearScreen: () => screen.clearScreen(),
    clearLine: (r?: number) => screen.clearLine(r),
    newLine: () => screen.newLine(),
    row: () => screen.row,
    column: () => screen.col,
  };
  for (const [py, cpp] of Object.entries(PY_SCREEN_NAMES)) scr[py] = scr[cpp];
  api.Screen = scr;
  api.screen = scr;
  return { api, dispose };
}
