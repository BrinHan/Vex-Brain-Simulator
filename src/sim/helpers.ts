import { Kw } from './screen';

/** Thrown inside user code when the run is stopped; never reported as an error. */
export class StopSignal extends Error {
  constructor() {
    super('Program stopped');
  }
}

/** Python dict (also used for std::map): own string keys, methods live on the prototype. */
export class PyDict {
  [key: string]: any;
  get(k: unknown, d: unknown = null): unknown { const key = String(k); return key in this ? (this as Record<string, unknown>)[key] : d; }
  keys(): string[] { return Object.keys(this); }
  values(): unknown[] { return Object.values(this); }
  items(): [string, unknown][] { return Object.entries(this); }
  pop(k: unknown, d?: unknown): unknown { const key = String(k); const v = (this as Record<string, unknown>)[key]; delete (this as Record<string, unknown>)[key]; return v ?? d; }
  update(o: PyDict): void { Object.assign(this, o); }
  setdefault(k: unknown, d: unknown): unknown { const key = String(k); if (!(key in this)) (this as Record<string, unknown>)[key] = d; return (this as Record<string, unknown>)[key]; }
  clear(): void { for (const k of Object.keys(this)) delete (this as Record<string, unknown>)[k]; }
  count(k: unknown): number { return String(k) in this ? 1 : 0; }
  erase(k: unknown): void { delete (this as Record<string, unknown>)[String(k)]; }
  size(): number { return Object.keys(this).length; }
  empty(): boolean { return Object.keys(this).length === 0; }
}

/**
 * A C `char buf[N]`: strings are immutable in JS, so character arrays are mutable objects that snprintf/strcpy
 * write into. Reads (printf %s, strlen, getStringWidth ...) see the current text through toString().
 * `buf + n` gives a view that writes through to the original buffer.
 */
export class CBuf {
  private text = '';
  constructor(public size: number, private base?: CBuf, private off = 0) {}
  get s(): string { return this.base ? this.base.s.slice(this.off) : this.text; }
  set s(v: string) {
    if (this.base) this.base.s = this.base.s.slice(0, this.off) + v;
    else this.text = this.size > 0 ? v.slice(0, this.size - 1) : v;
  }
  toString(): string { return this.s; }
  valueOf(): string { return this.s; }
  view(n: number): CBuf { return new CBuf(this.size - n, this, n); }
}

// ------------------------------------------------------------------ string conversion / formatting

export function pyRepr(x: unknown): string {
  if (typeof x === 'string') return `'${x.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  return pystr(x);
}

export function pystr(x: unknown): string {
  if (x === true) return 'True';
  if (x === false) return 'False';
  if (x === null || x === undefined) return 'None';
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return Number.isInteger(x) ? String(x) : String(x);
  if (Array.isArray(x)) return `[${x.map(pyRepr).join(', ')}]`;
  if (x instanceof PyDict) return `{${Object.entries(x).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
  return String(x);
}

function pad(s: string, width: number, left: boolean, zero: boolean): string {
  if (s.length >= width) return s;
  if (left) return s + ' '.repeat(width - s.length);
  if (zero) {
    const m = /^([+\- ]?)(.*)$/.exec(s) as RegExpExecArray;
    return m[1] + '0'.repeat(width - s.length) + m[2];
  }
  return ' '.repeat(width - s.length) + s;
}

/** printf-style formatting (C and python `%`). */
export function sprintf(fmt: string, args: unknown[]): string {
  let ai = 0;
  return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?(hh|h|ll|l|z|L|j|t)?([diufFeEgGxXoscp%])/g, (_m, flags: string, w: string, p: string, _len: string, t: string) => {
    if (t === '%') return '%';
    let width = w === '*' ? Number(args[ai++]) : w ? parseInt(w, 10) : 0;
    const prec = p === '*' ? Number(args[ai++]) : p !== undefined ? parseInt(p, 10) : undefined;
    const left = flags.includes('-') || width < 0;
    width = Math.abs(width);
    const arg = args[ai++];
    const sign = (n: number, s: string): string => (n >= 0 && flags.includes('+') ? '+' + s : n >= 0 && flags.includes(' ') ? ' ' + s : s);
    const num = typeof arg === 'boolean' ? (arg ? 1 : 0) : Number(arg);
    let out: string;
    switch (t) {
      case 'd': case 'i': case 'u': {
        const n = Number.isFinite(num) ? Math.trunc(num) : 0;
        out = sign(n, String(t === 'u' && n < 0 ? n >>> 0 : n));
        break;
      }
      case 'f': case 'F': out = sign(num, num.toFixed(prec ?? 6)); break;
      case 'e': case 'E': {
        out = num.toExponential(prec ?? 6).replace(/e([+-])(\d)$/, 'e$10$2');
        if (t === 'E') out = out.toUpperCase();
        out = sign(num, out);
        break;
      }
      case 'g': case 'G': {
        const pr = prec === 0 ? 1 : prec ?? 6;
        let s = num.toPrecision(pr);
        if (s.includes('e')) s = s.replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2');
        else if (s.includes('.') && !flags.includes('#')) s = s.replace(/\.?0+$/, '');
        out = sign(num, t === 'G' ? s.toUpperCase() : s);
        break;
      }
      case 'x': out = (Math.trunc(num) >>> 0).toString(16); if (flags.includes('#')) out = '0x' + out; break;
      case 'X': out = (Math.trunc(num) >>> 0).toString(16).toUpperCase(); if (flags.includes('#')) out = '0X' + out; break;
      case 'o': out = (Math.trunc(num) >>> 0).toString(8); break;
      case 'c': out = typeof arg === 'number' ? String.fromCharCode(arg) : String(arg ?? '').charAt(0); break;
      case 'p': out = '0x' + (Number(arg) || 0).toString(16); break;
      default: {
        // s
        let s = typeof arg === 'string' ? arg : pystr(arg);
        if (prec !== undefined) s = s.slice(0, prec);
        out = s;
      }
    }
    return pad(out, width, left, flags.includes('0') && !'sc'.includes(t));
  });
}

/** Python format-spec mini language for f-strings, format() and str.format. */
export function fmtv(value: unknown, spec: string, conv: string): string {
  let v = value;
  if (conv === 'r') v = pyRepr(v);
  else if (conv === 's') v = pystr(v);
  if (!spec) return pystr(v);
  const m = /^(?:(.)?([<>^=]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(spec);
  if (!m) return pystr(v);
  let [, fill, align] = m;
  const [, , , sign, alt, zero, widthS, group, precS, type] = m;
  const width = widthS ? parseInt(widthS, 10) : 0;
  const prec = precS !== undefined ? parseInt(precS, 10) : undefined;
  let body: string;
  const isNum = typeof v === 'number' || typeof v === 'boolean';
  if (isNum) {
    const n = Number(v);
    const abs = Math.abs(n);
    switch (type) {
      case 'f': case 'F': body = abs.toFixed(prec ?? 6); break;
      case 'e': case 'E': body = abs.toExponential(prec ?? 6).replace(/e([+-])(\d)$/, 'e$10$2'); if (type === 'E') body = body.toUpperCase(); break;
      case 'g': case 'G': body = prec !== undefined ? String(Number(abs.toPrecision(prec || 1))) : String(abs); break;
      case 'x': body = Math.trunc(abs).toString(16); if (alt) body = '0x' + body; break;
      case 'X': body = Math.trunc(abs).toString(16).toUpperCase(); if (alt) body = '0X' + body; break;
      case 'o': body = Math.trunc(abs).toString(8); break;
      case 'b': body = Math.trunc(abs).toString(2); if (alt) body = '0b' + body; break;
      case 'c': body = String.fromCharCode(n); break;
      case '%': body = (abs * 100).toFixed(prec ?? 6) + '%'; break;
      case 'd': case 'n': body = String(Math.trunc(abs)); break;
      default: body = prec !== undefined ? String(Number(abs.toPrecision(prec || 1))) : String(abs);
    }
    if (group) {
      const [ip, fp] = body.split('.');
      body = ip.replace(/\B(?=(\d{3})+(?!\d))/g, group) + (fp !== undefined ? '.' + fp : '');
    }
    const neg = n < 0;
    const sgn = neg ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '';
    if (!align) align = zero ? '=' : '>';
    if (zero && !fill) fill = '0';
    const fc = fill ?? ' ';
    const total = sgn.length + body.length;
    const padN = Math.max(0, width - total);
    if (align === '=') return sgn + fc.repeat(padN) + body;
    if (align === '<') return sgn + body + fc.repeat(padN);
    if (align === '^') return fc.repeat(Math.floor(padN / 2)) + sgn + body + fc.repeat(Math.ceil(padN / 2));
    return fc.repeat(padN) + sgn + body;
  }
  let s = pystr(v);
  if (prec !== undefined) s = s.slice(0, prec);
  const fc = fill ?? ' ';
  const padN = Math.max(0, width - s.length);
  if (align === '>') return fc.repeat(padN) + s;
  if (align === '^') return fc.repeat(Math.floor(padN / 2)) + s + fc.repeat(Math.ceil(padN / 2));
  return s + fc.repeat(padN);
}

function strFormat(self: string, args: unknown[]): string {
  const last = args[args.length - 1];
  const kw = last instanceof Kw ? last.o : {};
  const pos = last instanceof Kw ? args.slice(0, -1) : args;
  let auto = 0;
  return self.replace(/\{\{|\}\}|\{([^{}!:]*)(?:!([rs]))?(?::([^{}]*))?\}/g, (m, name: string, conv: string, spec: string) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    let val: unknown;
    if (name === '' || name === undefined) val = pos[auto++];
    else if (/^\d+$/.test(name)) val = pos[Number(name)];
    else val = kw[name];
    return fmtv(val, spec ?? '', conv ?? '');
  });
}

// ------------------------------------------------------------------ equality / truthiness / sequences

export function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (a instanceof PyDict && b instanceof PyDict) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function truthy(x: unknown): boolean {
  if (x === null || x === undefined || x === false || x === 0 || x === '' || Number.isNaN(x)) return false;
  if (Array.isArray(x)) return x.length > 0;
  if (x instanceof PyDict) return Object.keys(x).length > 0;
  return true;
}

function typeName(x: unknown): string {
  if (typeof x === 'number') return Number.isInteger(x) ? 'int' : 'float';
  if (typeof x === 'string') return 'str';
  if (Array.isArray(x)) return 'list';
  if (x === null || x === undefined) return 'NoneType';
  return typeof x;
}

function normIndex(i: number, n: number): number {
  return i < 0 ? Math.max(0, n + i) : Math.min(i, n);
}

export function pySlice(o: unknown, lo?: number, hi?: number, step?: number): unknown {
  const arr = typeof o === 'string' ? Array.from(o) : (o as unknown[]);
  const n = arr.length;
  const st = step ?? 1;
  if (st === 0) throw new Error('ValueError: slice step cannot be zero');
  const out: unknown[] = [];
  if (st > 0) {
    const a = lo === undefined ? 0 : normIndex(lo, n);
    const b = hi === undefined ? n : normIndex(hi, n);
    for (let i = a; i < b; i += st) out.push(arr[i]);
  } else {
    const a = lo === undefined ? n - 1 : Math.min(lo < 0 ? n + lo : lo, n - 1);
    const b = hi === undefined ? -1 : hi < 0 ? n + hi : hi;
    for (let i = a; i > b; i += st) out.push(arr[i]);
  }
  return typeof o === 'string' ? out.join('') : out;
}

export function copyDeep(x: unknown): unknown {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(copyDeep);
  const proto = Object.getPrototypeOf(x);
  if (proto && proto.constructor && proto.constructor.name === 'VexColor') return x;
  const o = Object.create(proto);
  for (const k of Object.keys(x)) o[k] = copyDeep((x as Record<string, unknown>)[k]);
  return o;
}

// ------------------------------------------------------------------ prototype helpers for python / C++ container methods

let installed = false;
export function installPrototypes(): void {
  if (installed) return;
  installed = true;
  const def = (proto: object, name: string, fn: (this: any, ...a: any[]) => unknown): void => {
    Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true, enumerable: false });
  };
  const A = Array.prototype;
  def(A, 'push_back', function (v) { this.push(v); });
  def(A, 'pop_back', function () { this.pop(); });
  def(A, 'append', function (v) { this.push(v); });
  def(A, 'extend', function (v) { this.push(...Array.from(v as Iterable<unknown>)); });
  def(A, 'empty', function () { return this.length === 0; });
  def(A, 'back', function () { return this[this.length - 1]; });
  def(A, 'front', function () { return this[0]; });
  def(A, 'clear', function () { this.length = 0; });
  def(A, 'insert', function (i, v) { this.splice(i < 0 ? Math.max(0, this.length + i) : i, 0, v); });
  def(A, 'erase', function (i) { this.splice(i, 1); });
  def(A, 'remove', function (v) { const i = this.findIndex((x: unknown) => eq(x, v)); if (i < 0) throw new Error('ValueError: list.remove(x): x not in list'); this.splice(i, 1); });
  def(A, 'index', function (v) { const i = this.findIndex((x: unknown) => eq(x, v)); if (i < 0) throw new Error('ValueError: value is not in list'); return i; });
  def(A, 'count', function (v) { return this.filter((x: unknown) => eq(x, v)).length; });
  def(A, 'copy', function () { return this.slice(); });
  def(A, 'swap', function (o) { const t = this.slice(); this.length = 0; this.push(...o); o.length = 0; o.push(...t); });
  const S = String.prototype;
  def(S, 'upper', function () { return this.toUpperCase(); });
  def(S, 'lower', function () { return this.toLowerCase(); });
  def(S, 'strip', function (c) { return c ? this.replace(new RegExp(`^[${c}]+|[${c}]+$`, 'g'), '') : this.trim(); });
  def(S, 'lstrip', function () { return this.trimStart(); });
  def(S, 'rstrip', function () { return this.trimEnd(); });
  def(S, 'startswith', function (p) { return this.startsWith(p); });
  def(S, 'endswith', function (p) { return this.endsWith(p); });
  def(S, 'format', function (...a) { return strFormat(String(this), a); });
  def(S, 'join', function (it) { return Array.from(it as Iterable<unknown>).map(pystr).join(String(this)); });
  def(S, 'isdigit', function () { return /^\d+$/.test(this); });
  def(S, 'isalpha', function () { return /^[A-Za-z]+$/.test(this); });
  def(S, 'isalnum', function () { return /^[A-Za-z0-9]+$/.test(this); });
  def(S, 'isspace', function () { return /^\s+$/.test(this); });
  def(S, 'isupper', function () { return this.length > 0 && this === this.toUpperCase() && this !== this.toLowerCase(); });
  def(S, 'islower', function () { return this.length > 0 && this === this.toLowerCase() && this !== this.toUpperCase(); });
  def(S, 'title', function () { return this.toLowerCase().replace(/(^|\s)\S/g, (c: string) => c.toUpperCase()); });
  def(S, 'capitalize', function () { return this.charAt(0).toUpperCase() + this.slice(1).toLowerCase(); });
  def(S, 'zfill', function (n) { return this.padStart(n, '0'); });
  def(S, 'ljust', function (n, c = ' ') { return this.padEnd(n, c); });
  def(S, 'rjust', function (n, c = ' ') { return this.padStart(n, c); });
  def(S, 'center', function (n, c = ' ') { const t = Math.max(0, n - this.length); return c.repeat(Math.floor(t / 2)) + this + c.repeat(Math.ceil(t / 2)); });
  def(S, 'size', function () { return this.length; });
  def(S, 'c_str', function () { return String(this); });
  def(S, 'find', function (x, from) { return this.indexOf(x, from); });
  def(S, 'rfind', function (x) { return this.lastIndexOf(x); });
  def(S, 'count', function (x) { return x === '' ? this.length + 1 : this.split(x).length - 1; });
  def(S, 'index', function (x) { const i = this.indexOf(x); if (i < 0) throw new Error('ValueError: substring not found'); return i; });
}

// ------------------------------------------------------------------ helper table passed to generated code

export interface HelperHost {
  stopped: boolean;
  sleep(ms: number): Promise<void>;
  globals: Record<string, any>;
  makeDevice(type: string, name: string, args: unknown[]): unknown;
}

export function createHelpers(host: HelperHost): Record<string, any> {
  installPrototypes();
  let ticks = 0;
  const iter = (x: unknown): Iterable<unknown> => {
    if (Array.isArray(x)) return x;
    if (typeof x === 'string') return Array.from(x);
    if (x instanceof PyDict) return Object.keys(x);
    if (x !== null && x !== undefined && typeof (x as Iterable<unknown>)[Symbol.iterator] === 'function') return x as Iterable<unknown>;
    throw new Error(`TypeError: '${typeName(x)}' object is not iterable`);
  };
  const h: Record<string, any> = {
    async tick() {
      if (host.stopped) throw new StopSignal();
      if ((++ticks & 1023) === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
        if (host.stopped) throw new StopSignal();
      }
    },
    isStop: (e: unknown) => e instanceof StopSignal,
    /** Records the source line an error was thrown on (only the first, innermost tag counts). */
    tagLine(e: unknown, line: number) {
      if (line && e instanceof Error && !(e instanceof StopSignal) && (e as { vexLine?: number }).vexLine === undefined) {
        (e as { vexLine?: number }).vexLine = line;
      }
      return e;
    },
    errval: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    pyerr: (v: unknown) => (v instanceof Error ? v : new Error(typeof v === 'string' ? v : pystr(v))),
    idiv(a: number, b: number) {
      if (b === 0) throw new Error('Division by zero (integer division by 0 crashes a real program)');
      return Math.trunc(a / b);
    },
    truediv(a: number, b: number) {
      if (b === 0) throw new Error('ZeroDivisionError: division by zero');
      return a / b;
    },
    floordiv(a: number, b: number) {
      if (b === 0) throw new Error('ZeroDivisionError: integer division or modulo by zero');
      return Math.floor(a / b);
    },
    pmod(a: unknown, b: unknown) {
      if (typeof a === 'string') return sprintf(a, Array.isArray(b) ? b : [b]);
      const x = a as number;
      const y = b as number;
      if (y === 0) throw new Error('ZeroDivisionError: integer division or modulo by zero');
      const r = x % y;
      return r !== 0 && r < 0 !== y < 0 ? r + y : r;
    },
    padd(a: unknown, b: unknown) {
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      throw new Error(`TypeError: unsupported operand type(s) for +: '${typeName(a)}' and '${typeName(b)}'`);
    },
    pmul(a: unknown, b: unknown) {
      if (typeof a === 'number' && typeof b === 'number') return a * b;
      if (typeof a === 'string' && typeof b === 'number') return a.repeat(Math.max(0, b));
      if (typeof b === 'string' && typeof a === 'number') return b.repeat(Math.max(0, a));
      if (Array.isArray(a) && typeof b === 'number') return Array.from({ length: Math.max(0, b) }, () => a.slice()).flat();
      if (Array.isArray(b) && typeof a === 'number') return Array.from({ length: Math.max(0, a) }, () => b.slice()).flat();
      throw new Error(`TypeError: unsupported operand type(s) for *: '${typeName(a)}' and '${typeName(b)}'`);
    },
    eq,
    truthy,
    in(a: unknown, b: unknown) {
      if (typeof b === 'string') return b.includes(String(a));
      if (Array.isArray(b)) return b.some((x) => eq(x, a));
      if (b instanceof PyDict) return String(a) in b;
      throw new Error(`TypeError: argument of type '${typeName(b)}' is not iterable`);
    },
    str: pystr,
    fmtv,
    iter,
    unpack: (v: unknown) => Array.from(iter(v)),
    at(o: any, i: any) {
      if (o instanceof PyDict) {
        const k = String(i);
        if (!(k in o)) throw new Error(`KeyError: ${pyRepr(i)}`);
        return (o as Record<string, unknown>)[k];
      }
      if (typeof i === 'number') {
        const n = o.length;
        const j = i < 0 ? n + i : i;
        if (j < 0 || j >= n) throw new Error('IndexError: index out of range');
        return o[j];
      }
      return o[i];
    },
    slice: pySlice,
    kw: (o: Record<string, unknown>) => new Kw(o),
    dict(entries: [unknown, unknown][]) {
      const d = new PyDict();
      for (const [k, v] of entries) (d as Record<string, unknown>)[String(k)] = v;
      return d;
    },
    map: () => new PyDict(),
    async mkarr(n: number, f: () => Promise<unknown>) {
      const a: unknown[] = [];
      for (let i = 0; i < n; i++) a.push(await f());
      return a;
    },
    async fill(a: unknown[], n: number, f: () => Promise<unknown>) {
      while (a.length < n) a.push(await f());
      return a;
    },
    vec(n?: number, v: unknown = 0) {
      return n === undefined ? [] : Array.from({ length: n }, () => copyDeep(v));
    },
    copy: copyDeep,
    ord: (x: unknown) => (typeof x === 'string' ? x.charCodeAt(0) : typeof x === 'boolean' ? Number(x) : x),
    chr: (x: unknown) => (typeof x === 'number' ? String.fromCharCode(x) : x),
    toint(x: unknown) {
      if (typeof x === 'string') { const n = parseInt(x, 10); return Number.isNaN(n) ? (x.length === 1 ? x.charCodeAt(0) : 0) : n; }
      const n = Math.trunc(Number(x));
      return Number.isNaN(n) ? 0 : n;
    },
    size(x: any) {
      if (typeof x === 'string' || Array.isArray(x)) return x.length;
      if (x instanceof PyDict) return Object.keys(x).length;
      if (x && typeof x.size === 'function') return x.size();
      return 0;
    },
    cbuf: (n: number) => new CBuf(n),
    ptradd(p: unknown, n: number) {
      if (p instanceof CBuf) return p.view(n);
      if (typeof p === 'string') return p.slice(n);
      return (p as number) + n;
    },
    sizeof(x: unknown) {
      if (x instanceof CBuf) return x.size;
      if (Array.isArray(x)) return x.length * 4;
      if (typeof x === 'string') return { char: 1, double: 8, long: 8, short: 2, bool: 1, float: 4 }[x as 'char'] ?? 4;
      return 4;
    },
    shl(l: any, r: unknown) {
      if (l && l.__isCout) { l.write(r); return l; }
      return (l as number) << (r as number);
    },
    async new(cls: any, args: unknown[]) {
      if (typeof cls !== 'function') throw new Error('TypeError: not a class');
      const o = new cls();
      await o.__fi();
      if (typeof o.__init__ === 'function') await o.__init__(...args);
      else if (args.length) args.forEach((a, i) => { o[cls.__fields[i]] = a; });
      return o;
    },
    async make(name: string, args: unknown[]) {
      const f = host.globals[name];
      if (typeof f === 'function') return await f(...args);
      if (name === 'vector' || name === 'array') return h.vec(...(args as []));
      if (name === 'string') return args.length ? String(args[0]) : '';
      return stub(name); // device/library types the simulator does not model (mutex, FILE, ...)
    },
    device: (type: string, name: string, args: unknown[]) => host.makeDevice(type, name, args),
    async waitUntil(cond: () => Promise<boolean>) {
      while (!(await cond())) await host.sleep(10);
    },
    async pypop(l: any[] | PyDict, i?: number) {
      if (l instanceof PyDict) return l.pop(i);
      if (!l.length) throw new Error('IndexError: pop from empty list');
      return i === undefined ? l.pop() : l.splice(i < 0 ? l.length + i : i, 1)[0];
    },
    async pysort(l: any[], ...a: unknown[]) {
      const last = a[a.length - 1];
      const kw = last instanceof Kw ? last.o : {};
      await sortInPlace(l, kw.key as ((x: unknown) => unknown) | undefined, !!kw.reverse);
    },
    pysplit(s: string, sep?: string, max?: number) {
      if (sep === undefined || sep === null) return s.trim() === '' ? [] : s.trim().split(/\s+/);
      const parts = s.split(sep);
      if (max !== undefined && max >= 0 && parts.length > max + 1) return [...parts.slice(0, max), parts.slice(max).join(sep)];
      return parts;
    },
  };
  return h;
}

export async function sortInPlace(l: unknown[], key?: (x: unknown) => unknown, reverse = false, cmp?: (a: unknown, b: unknown) => unknown): Promise<void> {
  const keys = await Promise.all(l.map(async (x) => (key ? await key(x) : x)));
  const idx = l.map((_, i) => i);
  const cmpKeys = async (a: number, b: number): Promise<number> => {
    if (cmp) {
      if (await cmp(l[a], l[b])) return -1;
      if (await cmp(l[b], l[a])) return 1;
      return 0;
    }
    const x = keys[a] as any;
    const y = keys[b] as any;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  // async merge sort (stable)
  const sorted = await (async function ms(a: number[]): Promise<number[]> {
    if (a.length <= 1) return a;
    const mid = a.length >> 1;
    const left = await ms(a.slice(0, mid));
    const right = await ms(a.slice(mid));
    const out: number[] = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) out.push((await cmpKeys(left[i], right[j])) <= 0 ? left[i++] : right[j++]);
    while (i < left.length) out.push(left[i++]);
    while (j < right.length) out.push(right[j++]);
    return out;
  })(idx);
  const vals = sorted.map((i) => l[i]);
  if (reverse) vals.reverse();
  for (let i = 0; i < vals.length; i++) l[i] = vals[i];
}

/** A callable, property-accepting stand-in for devices the simulator does not model (motors, sensors...). */
export function stub(label: string): any {
  const target = function () {} as any;
  return new Proxy(target, {
    get(_t, prop) {
      // behaves like the number 0 in arithmetic/comparisons and prints as "0"
      if (prop === Symbol.toPrimitive) return (hint: string) => (hint === 'string' ? '0' : 0);
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === 'installed') return () => true; // a missing device would only confuse a visual test
      return stub(`${label}.${String(prop)}`);
    },
    apply: () => 0,
  });
}

const JS_BUILTINS = new Set([
  'undefined', 'NaN', 'Infinity', 'Math', 'Number', 'String', 'Object', 'Array', 'Promise', 'JSON', 'Date', 'Error', 'Symbol',
  'Boolean', 'Map', 'Set', 'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'console', 'globalThis', 'arguments', 'eval',
]);

/**
 * The global scope user code runs in (`with ($g)`): VEX API names come from `globals`; any other name the program
 * uses but never defines (symbols from headers that were not pasted, e.g. `Gyro`, `currentTab`) becomes an
 * assignable stub, with a one-time warning so real typos are still visible.
 */
export function scopeProxy(globals: Record<string, any>, warn: (name: string) => void): Record<string, any> {
  const external = new Map<string, unknown>();
  return new Proxy(globals, {
    has: (_t, k) => typeof k === 'string' && !k.startsWith('$') && !JS_BUILTINS.has(k),
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      if (!external.has(k)) { external.set(k, stub(k)); warn(k); }
      return external.get(k);
    },
    set(t, k, v) {
      if (typeof k !== 'string') return false;
      if (k in t) t[k] = v;
      else external.set(k, v);
      return true;
    },
  });
}
