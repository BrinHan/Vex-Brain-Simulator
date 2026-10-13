/** VEX color value. `transparent` means "draw nothing" for fills and pens. */
export class VexColor {
  constructor(
    public r: number,
    public g: number,
    public b: number,
    public transparent = false,
  ) {}

  css(): string {
    return `rgb(${this.r}, ${this.g}, ${this.b})`;
  }

  toString(): string {
    return this.transparent ? 'transparent' : `#${[this.r, this.g, this.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  rgb(): number {
    return (this.r << 16) | (this.g << 8) | this.b;
  }
}

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255],
  yellow: [255, 255, 0], orange: [255, 165, 0], purple: [128, 0, 128], cyan: [0, 255, 255],
  magenta: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], pink: [255, 192, 203],
};

export function fromHex(n: number): VexColor {
  return new VexColor((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

export function fromHsv(h: number, s: number, v: number): VexColor {
  // h in degrees, s and v in 0..1
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return new VexColor(clamp((r + m) * 255), clamp((g + m) * 255), clamp((b + m) * 255));
}

/** Accepts VexColor, 0xRRGGBB numbers, "#rrggbb" / "#rgb" / named strings. Falls back to `fallback`. */
export function toColor(v: unknown, fallback: VexColor): VexColor {
  if (v instanceof VexColor) return v;
  if (typeof v === 'number') return fromHex(v);
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    const m6 = /^#?([0-9a-f]{6})$/.exec(s);
    if (m6) return fromHex(parseInt(m6[1], 16));
    const m3 = /^#([0-9a-f]{3})$/.exec(s);
    if (m3) return fromHex(parseInt(m3[1].split('').map((c) => c + c).join(''), 16));
    if (s === 'transparent') return new VexColor(0, 0, 0, true);
    if (NAMED[s]) return new VexColor(...NAMED[s]);
  }
  return fallback;
}

export const BLACK = new VexColor(0, 0, 0);
export const WHITE = new VexColor(255, 255, 255);

type ColorFactory = ((...args: unknown[]) => VexColor) & Record<string, unknown>;

/**
 * `color(r,g,b)`, `color(0xRRGGBB)`, `color("#RRGGBB")`, `color(hsv...)` plus constants such as `color.red`
 * (C++ style, lowercase) and `Color.RED` (Python style, uppercase).
 */
export function makeColorFactory(): ColorFactory {
  const f = ((...args: unknown[]): VexColor => {
    if (args.length >= 3) return new VexColor(clamp(args[0] as number), clamp(args[1] as number), clamp(args[2] as number));
    if (args.length === 1) return toColor(args[0], BLACK);
    return new VexColor(0, 0, 0);
  }) as ColorFactory;
  for (const [name, rgb] of Object.entries(NAMED)) {
    const c = new VexColor(...rgb);
    f[name] = c;
    f[name.toUpperCase()] = c;
  }
  const t = new VexColor(0, 0, 0, true);
  f.transparent = t;
  f.TRANSPARENT = t;
  f.rgb = (r: number, g: number, b: number) => new VexColor(clamp(r), clamp(g), clamp(b));
  f.hsv = (h: number, s: number, v: number) => fromHsv(h, s, v);
  return f;
}
