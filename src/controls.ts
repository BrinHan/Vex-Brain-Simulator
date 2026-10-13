// Drives the simulated controller from the keyboard (rebindable keys) or a real gamepad, and shows the
// Controls palette: a searchable list of every control and its key, where picking one lets you rebind it.
import { AXES, AxisNumber, BUTTONS, ButtonName, ControllerInput } from './sim/controller';

type AxisDir = `axis${AxisNumber}${'+' | '-'}`;
type ControlId = AxisDir | ButtonName;

interface Control { id: ControlId; label: string; icon: string }

/** Gamepad icon for the toolbar button and the gamepad row; the holes take the color of whatever is behind it. */
export const PAD_ICON =
  '<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10a4 4 0 0 1 4 4v3a2 2 0 0 1-3.5 1.3L13.5 12h-7l-2 2.3A2 2 0 0 1 1 13v-3a4 4 0 0 1 4-4z" fill="currentColor"/>' +
  '<path d="M6 8v3M4.5 9.5h3" stroke="var(--palette-ink, var(--surface-2))" stroke-width="1.4" stroke-linecap="round"/>' +
  '<circle cx="13" cy="9" r="0.9" fill="var(--palette-ink, var(--surface-2))"/><circle cx="15" cy="10.6" r="0.9" fill="var(--palette-ink, var(--surface-2))"/></svg>';

const stickIcon = (dx: number, dy: number): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/>` +
  `<circle cx="${10 + dx * 4}" cy="${10 + dy * 4}" r="3" fill="currentColor"/></svg>`;
const padIcon = (rot: number): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path transform="rotate(${rot} 10 10)" d="M10 3l5 6h-3v8H8V9H5z" fill="currentColor"/></svg>`;
const faceIcon = (letter: string): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="currentColor"/>` +
  `<text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" font-family="Inter, sans-serif" fill="var(--palette-ink)">${letter}</text></svg>`;
const shoulderIcon = (name: string): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="4" width="18" height="12" rx="4" fill="currentColor"/>` +
  `<text x="10" y="13.5" text-anchor="middle" font-size="8.5" font-weight="700" font-family="Inter, sans-serif" fill="var(--palette-ink)">${name}</text></svg>`;

export const CONTROLS: Control[] = [
  { id: 'axis3+', label: 'Left stick up (Axis 3)', icon: stickIcon(0, -1) },
  { id: 'axis3-', label: 'Left stick down (Axis 3)', icon: stickIcon(0, 1) },
  { id: 'axis4-', label: 'Left stick left (Axis 4)', icon: stickIcon(-1, 0) },
  { id: 'axis4+', label: 'Left stick right (Axis 4)', icon: stickIcon(1, 0) },
  { id: 'axis2+', label: 'Right stick up (Axis 2)', icon: stickIcon(0, -1) },
  { id: 'axis2-', label: 'Right stick down (Axis 2)', icon: stickIcon(0, 1) },
  { id: 'axis1-', label: 'Right stick left (Axis 1)', icon: stickIcon(-1, 0) },
  { id: 'axis1+', label: 'Right stick right (Axis 1)', icon: stickIcon(1, 0) },
  { id: 'L1', label: 'L1 bumper', icon: shoulderIcon('L1') },
  { id: 'L2', label: 'L2 trigger', icon: shoulderIcon('L2') },
  { id: 'R1', label: 'R1 bumper', icon: shoulderIcon('R1') },
  { id: 'R2', label: 'R2 trigger', icon: shoulderIcon('R2') },
  { id: 'Up', label: 'D-pad up', icon: padIcon(0) },
  { id: 'Down', label: 'D-pad down', icon: padIcon(180) },
  { id: 'Left', label: 'D-pad left', icon: padIcon(270) },
  { id: 'Right', label: 'D-pad right', icon: padIcon(90) },
  { id: 'X', label: 'X button', icon: faceIcon('X') },
  { id: 'Y', label: 'Y button', icon: faceIcon('Y') },
  { id: 'A', label: 'A button', icon: faceIcon('A') },
  { id: 'B', label: 'B button', icon: faceIcon('B') },
];

/** Left stick on WASD, right stick on IJKL, bumpers on Q/E and U/O, D-pad on the arrows, X/Y/A/B as a T/F/H/G diamond. */
export const DEFAULT_KEYS: Record<ControlId, string> = {
  'axis3+': 'KeyW', 'axis3-': 'KeyS', 'axis4-': 'KeyA', 'axis4+': 'KeyD',
  'axis2+': 'KeyI', 'axis2-': 'KeyK', 'axis1-': 'KeyJ', 'axis1+': 'KeyL',
  L1: 'KeyQ', L2: 'KeyE', R1: 'KeyU', R2: 'KeyO',
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  X: 'KeyT', Y: 'KeyF', A: 'KeyH', B: 'KeyG',
};

/** `KeyW` -> `W`, `ArrowUp` -> `↑`, `ShiftLeft` -> `Shift`. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (arrows[code]) return arrows[code];
  return code.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num ').replace(/(Left|Right)$/, '');
}

// standard-mapping gamepad buttons, matched to the V5 controller by position (V5: X top, B bottom, Y left, A right)
const PAD_BUTTONS: [number, ButtonName][] = [
  [0, 'B'], [1, 'A'], [2, 'Y'], [3, 'X'], [4, 'L1'], [5, 'R1'], [6, 'L2'], [7, 'R2'], [12, 'Up'], [13, 'Down'], [14, 'Left'], [15, 'Right'],
];
// [V5 axis, gamepad axis index, sign]: gamepads report "up" as negative
const PAD_AXES: [AxisNumber, number, number][] = [[1, 2, 1], [2, 3, -1], [3, 1, -1], [4, 0, 1]];
const DEADZONE = 0.08;

export interface ControlsOptions {
  input: ControllerInput;
  load(): string | null;
  save(json: string): void;
}

export class Controls {
  keys: Record<ControlId, string>;
  private kbHeld = new Set<ControlId>();
  private pad: { buttons: Set<ButtonName>; axes: Record<AxisNumber, number> } | null = null;
  private padName = '';
  private padLoop = 0;

  // palette
  private overlay!: HTMLDivElement;
  private search!: HTMLInputElement;
  private list!: HTMLDivElement;
  private padRow!: HTMLDivElement;
  private items: HTMLDivElement[] = [];
  /** The rows that show a control, with the axis direction or button each one lights up for. */
  private controlRows: { el: HTMLDivElement; axis?: AxisNumber; dir?: number; button?: ButtonName }[] = [];
  private selected = 0;
  private binding: ControlId | null = null;

  constructor(private opts: ControlsOptions) {
    this.keys = { ...DEFAULT_KEYS };
    try { Object.assign(this.keys, JSON.parse(opts.load() ?? '{}')); } catch { /* keep the defaults */ }
    this.buildPalette();
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.kbHeld.clear(); this.apply(); });
    window.addEventListener('gamepadconnected', () => this.startPad());
    window.addEventListener('gamepaddisconnected', () => this.startPad());
    opts.input.subscribe(() => { if (this.isOpen) this.renderHeld(); });
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  get isOpen(): boolean { return !this.overlay.hidden; }

  // ---------------------------------------------------------------- input
  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.isOpen) { if (down) this.paletteKey(e); return; }
    const t = e.target as HTMLElement | null;
    if (t && (t.closest('textarea, input, select, [contenteditable]'))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ids = (Object.keys(this.keys) as ControlId[]).filter((id) => this.keys[id] === e.code);
    if (!ids.length) return;
    e.preventDefault();
    for (const id of ids) if (down) this.kbHeld.add(id); else this.kbHeld.delete(id);
    this.apply();
  }

  /** Merges keyboard and gamepad into the controller: either one pressing a button presses it; a moved stick wins. */
  private apply(): void {
    const input = this.opts.input;
    for (const b of BUTTONS) input.setButton(b, this.kbHeld.has(b) || !!this.pad?.buttons.has(b));
    for (const n of AXES) {
      const kb = (this.kbHeld.has(`axis${n}+`) ? 100 : 0) - (this.kbHeld.has(`axis${n}-`) ? 100 : 0);
      const gp = this.pad?.axes[n] ?? 0;
      input.setAxis(n, Math.abs(gp) > DEADZONE * 100 ? gp : kb);
    }
  }

  private startPad(): void {
    if (this.padLoop) return;
    const poll = (): void => {
      const gp = Array.from(navigator.getGamepads?.() ?? []).find((g) => g && g.connected) ?? null;
      if (!gp) {
        this.padLoop = 0;
        this.pad = null;
        this.padName = '';
        this.apply();
        this.renderPadRow();
        return;
      }
      const pad = (this.pad ??= { buttons: new Set(), axes: { 1: 0, 2: 0, 3: 0, 4: 0 } });
      let changed = false;
      for (const [i, b] of PAD_BUTTONS) {
        const on = !!gp.buttons[i]?.pressed;
        if (on === pad.buttons.has(b)) continue;
        if (on) pad.buttons.add(b); else pad.buttons.delete(b);
        changed = true;
      }
      for (const [n, i, flip] of PAD_AXES) {
        const v = gp.axes[i] ?? 0;
        const p = Math.abs(v) < DEADZONE ? 0 : Math.round(v * 100 * flip);
        if (p !== pad.axes[n]) { pad.axes[n] = p; changed = true; }
      }
      if (this.padName !== gp.id) { this.padName = gp.id; this.renderPadRow(); }
      if (changed) this.apply();
      this.padLoop = requestAnimationFrame(poll);
    };
    this.padLoop = requestAnimationFrame(poll);
  }

  // ---------------------------------------------------------------- palette
  open(): void {
    this.overlay.hidden = false;
    this.kbHeld.clear();
    this.apply();
    this.search.value = '';
    this.binding = null;
    this.filter();
    this.renderHeld();
    this.search.focus();
  }

  close(): void {
    this.overlay.hidden = true;
    this.binding = null;
    this.renderKeys();
  }

  private buildPalette(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'palette-overlay';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="palette" role="dialog" aria-modal="true" aria-label="Controller controls">
        <div class="palette-search">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M13 13l4.5 4.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          <input type="text" placeholder="Search controls..." aria-label="Search controls" spellcheck="false" autocomplete="off" />
        </div>
        <div class="palette-list" role="listbox"></div>
        <div class="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span><span><kbd>Enter</kbd> change key</span><span><kbd>Esc</kbd> close</span>
          <span class="spacer"></span><span class="dim">Keys drive the controller while the editor isn't focused</span>
        </div>
      </div>`;
    document.body.appendChild(this.overlay);
    this.search = this.overlay.querySelector('input')!;
    this.list = this.overlay.querySelector('.palette-list')!;

    const row = (icon: string, label: string, onPick: () => void, id?: ControlId): HTMLDivElement => {
      const el = document.createElement('div');
      el.className = 'palette-item';
      el.setAttribute('role', 'option');
      if (id) el.dataset.id = id;
      el.innerHTML = `<span class="pi-icon">${icon}</span><span class="pi-label"></span><span class="pi-keys"></span>`;
      el.querySelector('.pi-label')!.textContent = label;
      el.addEventListener('mousemove', () => this.select(this.visible().indexOf(el), false));
      el.addEventListener('click', onPick);
      return el;
    };
    for (const c of CONTROLS) {
      const el = row(c.icon, c.label, () => this.startBinding(c.id), c.id);
      const m = /^axis(\d)([+-])$/.exec(c.id);
      this.controlRows.push(m ? { el, axis: Number(m[1]) as AxisNumber, dir: m[2] === '+' ? 1 : -1 } : { el, button: c.id as ButtonName });
      this.items.push(el);
    }
    const resetIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10a6 6 0 1 0 2-4.5M4 3v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    this.items.push(row(resetIcon, 'Reset all keys to defaults', () => { this.keys = { ...DEFAULT_KEYS }; this.saveKeys(); this.renderKeys(); }));
    this.padRow = row(PAD_ICON, '', () => {});
    this.padRow.classList.add('info');
    this.items.push(this.padRow);
    this.list.append(...this.items);
    this.renderKeys();
    this.renderPadRow();

    this.search.addEventListener('input', () => this.filter());
    this.overlay.addEventListener('mousedown', (e) => { if (e.target === this.overlay) this.close(); });
  }

  private visible(): HTMLDivElement[] { return this.items.filter((el) => !el.hidden); }

  private filter(): void {
    const q = this.search.value.trim().toLowerCase();
    for (const el of this.items) el.hidden = !!q && !el.textContent!.toLowerCase().includes(q);
    this.select(0, true);
  }

  private select(i: number, scroll: boolean): void {
    const vis = this.visible();
    if (!vis.length) return;
    this.selected = Math.max(0, Math.min(vis.length - 1, i));
    for (const el of this.items) el.classList.toggle('selected', el === vis[this.selected]);
    if (scroll) vis[this.selected].scrollIntoView({ block: 'nearest' });
  }

  private paletteKey(e: KeyboardEvent): void {
    if (this.binding) {
      e.preventDefault();
      if (e.code !== 'Escape') {
        this.keys[this.binding] = e.code === 'Backspace' || e.code === 'Delete' ? '' : e.code;
        this.saveKeys();
      }
      this.binding = null;
      this.renderKeys();
      this.search.focus();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.select(this.selected + 1, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.select(this.selected - 1, true); }
    else if (e.key === 'Enter') { e.preventDefault(); this.visible()[this.selected]?.click(); }
  }

  private startBinding(id: ControlId): void {
    this.binding = id;
    this.renderKeys();
    this.search.focus(); // keep focus off the list so it doesn't get a focus ring
  }

  private saveKeys(): void { this.opts.save(JSON.stringify(this.keys)); }

  private renderKeys(): void {
    for (const el of this.items) {
      const id = el.dataset.id as ControlId | undefined;
      if (!id) continue;
      const keys = el.querySelector('.pi-keys')!;
      const used = Object.values(this.keys).filter((k) => k && k === this.keys[id]).length > 1;
      keys.innerHTML = this.binding === id
        ? '<span class="pi-wait">Press a key&hellip; <span class="dim">(Esc cancels, Backspace clears)</span></span>'
        : `<kbd${used ? ' class="dup" title="Also used by another control"' : ''}></kbd>`;
      const kbd = keys.querySelector('kbd');
      if (kbd) kbd.textContent = keyLabel(this.keys[id]);
    }
  }

  private renderPadRow(): void {
    this.padRow.querySelector('.pi-label')!.textContent = this.padName
      ? `Gamepad connected: ${this.padName.replace(/\s*\(.*$/, '')}`
      : 'No gamepad connected (plug one in and press a button to use it)';
  }

  /** Rows light up while their control is held, so you can see the input arrive. */
  private renderHeld(): void {
    const input = this.opts.input;
    for (const r of this.controlRows) {
      r.el.classList.toggle('held', r.button ? input.held.has(r.button) : input.axes[r.axis!] * r.dir! > 0);
    }
  }
}
