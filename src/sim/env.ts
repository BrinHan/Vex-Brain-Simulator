import { BrainScreen, Kw, screenApi } from './screen';
import { makeColorFactory } from './color';
import { CBuf, PyDict, pystr, pyRepr, sortInPlace, sprintf, stub } from './helpers';

export interface EnvHost {
  screen: BrainScreen;
  lang: 'cpp' | 'py';
  log(text: string, kind?: 'out' | 'err' | 'warn' | 'info'): void;
  sleep(ms: number): Promise<void>;
  spawn(fn: unknown, args?: unknown[]): void;
  now(): number;
  requestStop(): void;
  competition: { auton?: unknown; driver?: unknown };
}

/** Namespace-like object whose every property is its own qualified name (e.g. Ports.PORT1 -> "Ports.PORT1"). */
function ns(name: string): any {
  return new Proxy({}, { get: (_t, p) => (typeof p === 'string' && p !== 'then' ? `${name}.${p}` : undefined) });
}

const unitMs = (t: number, units: unknown): number => (units === 'sec' || units === 'seconds' ? t * 1000 : units === 'minutes' ? t * 60000 : t);

function pyRound(x: number, nd?: number): number {
  const f = 10 ** (nd ?? 0);
  const v = x * f;
  const r = Math.round(v);
  const res = Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  return res / f;
}

export interface Env {
  globals: Record<string, any>;
  brainObj: Record<string, any>;
  flush(): void;
}

export function createEnv(host: EnvHost): Env {
  const g: Record<string, any> = {};
  const py = host.lang === 'py';

  // ---------------------------------------------------------------- brain
  const screen = screenApi(host.screen);
  const startedAt = { t: host.now() };
  const timer = {
    system: () => Math.floor(host.now()),
    time: (units?: unknown) => {
      const ms = host.now() - startedAt.t;
      return units === 'sec' || units === 'seconds' ? ms / 1000 : ms;
    },
    value: () => (host.now() - startedAt.t) / 1000,
    reset: () => { startedAt.t = host.now(); },
    clear: () => { startedAt.t = host.now(); },
    // vex::timer's functions are also reachable by these python-style names
    event: () => {},
  };
  const battery = {
    capacity: () => 100, voltage: () => 12.6, current: () => 0.5, temperature: () => 25,
  };
  const sdcard = { isInserted: () => false, exists: () => false, loadfile: () => 0, savefile: () => 0 };
  const brainObj: Record<string, any> = {
    Screen: screen, screen, Timer: timer, timer, Battery: battery, battery, SDcard: sdcard, sdcard,
    ThreeWirePort: stub('ThreeWirePort'), three_wire_port: stub('ThreeWirePort'),
    playSound: () => {}, play_sound: () => {}, programStop: () => host.requestStop(), program_stop: () => host.requestStop(),
    Lcd: stub('Lcd'),
  };
  // `Brain` is an object in C++ and constructed with Brain() in python
  const brainFn: any = Object.assign(() => brainObj, brainObj);
  g.Brain = brainFn;

  host.screen.sprintf = (f, a) => sprintf(f, a);
  host.screen.warn = (m) => host.log(m, 'warn');

  // ---------------------------------------------------------------- colors / fonts / units
  const color = makeColorFactory();
  g.color = color;
  g.Color = color;
  const fonts = Object.fromEntries(['mono12', 'mono15', 'mono20', 'mono30', 'mono40', 'mono60', 'prop20', 'prop30', 'prop40', 'prop60'].flatMap((f) => [[f, f], [f.toUpperCase(), f]]));
  g.fontType = fonts;
  g.FontType = fonts;
  g.msec = 'msec'; g.MSEC = 'msec'; g.sec = 'sec'; g.seconds = 'sec'; g.SECONDS = 'sec'; g.minutes = 'minutes'; g.MINUTES = 'minutes';
  g.timeUnits = { msec: 'msec', sec: 'sec', seconds: 'sec', minutes: 'minutes' };
  g.TimeUnits = g.timeUnits;

  // VEX constants that are only ever handed to (stubbed) devices
  const constNames = [
    ...Array.from({ length: 21 }, (_, i) => `PORT${i + 1}`),
    'ratio36_1', 'ratio18_1', 'ratio6_1', 'forward', 'reverse', 'fwd', 'percent', 'pct', 'rpm', 'dps', 'volt', 'velocityUnits',
    'percentUnits', 'voltageUnits', 'rotationUnits', 'brakeType', 'brake', 'coast', 'hold', 'directionType', 'turnType', 'left', 'right',
    'degrees', 'deg', 'rev', 'turns', 'distanceUnits', 'mm', 'inches', 'cm', 'analogUnits', 'range12bit', 'primary', 'partner', 'axisType',
    'xaxis', 'yaxis', 'zaxis', 'gearSetting', 'ThreeWire', 'temperatureUnits', 'currentUnits', 'powerUnits', 'torqueUnits',
    'FORWARD', 'REVERSE', 'PERCENT', 'RPM', 'DPS', 'VOLT', 'DEGREES', 'TURNS', 'MM', 'INCHES', 'PRIMARY', 'PARTNER', 'LEFT', 'RIGHT', 'HOLD',
    'COAST', 'BRAKE', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H',
  ];
  for (const n of constNames) if (!(n in g)) g[n] = n;
  for (const n of ['Ports', 'GearSetting', 'BrakeType', 'TurnType', 'DirectionType', 'VelocityUnits', 'PercentUnits', 'VoltageUnits',
    'RotationUnits', 'DistanceUnits', 'AxisType', 'TemperatureUnits', 'CurrentUnits', 'PowerUnits', 'TorqueUnits', 'AnalogUnits', 'ThreeWirePort']) g[n] = ns(n);

  // ---------------------------------------------------------------- time / threads
  const wait = async (t: number, units?: unknown): Promise<void> => { await host.sleep(unitMs(Number(t), units)); };
  g.wait = wait;
  g.sleep = async (t: number) => { await host.sleep(py ? Number(t) * 1000 : Number(t)); };
  g.wait_until = async (cond: () => Promise<boolean>) => { while (!(await cond())) await host.sleep(10); };
  g.this_thread = { sleep_for: async (ms: number) => { await host.sleep(Number(ms)); }, yield: async () => { await host.sleep(0); } };
  const spawner = (fn: unknown, arg?: unknown): any => {
    const args = arg === undefined ? [] : py && Array.isArray(arg) ? arg : [arg];
    host.spawn(fn, args);
    return { join: () => {}, interrupt: () => {}, stop: () => {}, join_(): void {}, setPriority: () => {}, id: () => 1 };
  };
  g.thread = spawner;
  g.Thread = spawner;
  g.task = Object.assign((fn: unknown, arg?: unknown) => spawner(fn, arg), { sleep: async (ms: number) => { await host.sleep(Number(ms)); }, yield: async () => { await host.sleep(0); } });
  const makeTimer = (): any => {
    const t0 = { t: host.now() };
    return {
      time: (units?: unknown) => { const ms = host.now() - t0.t; return units === 'sec' ? ms / 1000 : ms; },
      value: () => (host.now() - t0.t) / 1000,
      clear: () => { t0.t = host.now(); },
      reset: () => { t0.t = host.now(); },
      event: () => {},
    };
  };
  g.timer = makeTimer;
  g.Timer = makeTimer;

  // ---------------------------------------------------------------- competition + generic devices
  const competition: any = {
    autonomous: (fn: unknown) => { host.competition.auton = fn; },
    drivercontrol: (fn: unknown) => { host.competition.driver = fn; },
    isEnabled: () => true, isAutonomous: () => false, isDriverControl: () => true,
    isCompetitionSwitch: () => false, isFieldControl: () => false,
  };
  if (py) {
    g.Competition = (driver?: unknown, auton?: unknown) => {
      if (driver) host.competition.driver = driver;
      if (auton) host.competition.auton = auton;
      return competition;
    };
  } else g.competition = () => competition;
  // python constructors (Motor(...)) only exist in python: in C++ names like `Gyro` or `Controller1` belong to the user
  const pyDevices = ['Motor', 'MotorGroup', 'Inertial', 'Controller', 'DigitalOut', 'DigitalIn', 'AnalogIn', 'AnalogOut', 'Encoder', 'Optical', 'Distance',
    'Rotation', 'Vision', 'Gps', 'Limit', 'Bumper', 'Led', 'Pot', 'Line', 'Pneumatics', 'Gyro', 'Sonar', 'AiVision', 'Signature', 'Triport', 'PwmOut'];
  const cppDevices = ['motor', 'motor_group', 'inertial', 'controller', 'digital_out', 'digital_in', 'analog_in', 'encoder', 'optical', 'distance', 'rotation',
    'vision', 'gps', 'limit', 'bumper', 'led', 'pot', 'line', 'pneumatics', 'gyro', 'sonar', 'aivision', 'signature', 'triport'];
  for (const n of py ? [...pyDevices, ...cppDevices] : cppDevices) g[n] = (..._a: unknown[]) => stub(n);

  // ---------------------------------------------------------------- console output
  let line = '';
  const flush = (): void => { if (line) { host.log(line, 'out'); line = ''; } };
  const writeOut = (s: string): void => {
    line += s;
    let i: number;
    while ((i = line.indexOf('\n')) >= 0) { host.log(line.slice(0, i), 'out'); line = line.slice(i + 1); }
  };
  const endl = { __endl: true };
  g.endl = endl;
  g.cout = { __isCout: true, write: (x: unknown) => (x === endl ? writeOut('\n') : writeOut(typeof x === 'boolean' ? (x ? '1' : '0') : String(x))) };
  g.cerr = g.cout;

  if (py) installPython(g, host, writeOut, flush);
  else installCpp(g, host, writeOut);

  return { globals: g, brainObj, flush };
}

// ==================================================================== C++ library
function installCpp(g: Record<string, any>, host: EnvHost, out: (s: string) => void): void {
  g.printf = (fmt: string, ...a: unknown[]) => { out(sprintf(String(fmt), a)); return 0; };
  g.puts = (s: unknown) => { out(String(s) + '\n'); return 0; };
  g.putchar = (c: unknown) => { out(typeof c === 'number' ? String.fromCharCode(c) : String(c)); return c; };
  // C string/buffer functions: destinations are CBuf objects (char arrays), sources can be strings or CBufs
  const write = (dst: unknown, text: string, max?: number): number => {
    const t = max === undefined ? text : text.slice(0, Math.max(0, max - 1));
    if (dst instanceof CBuf) dst.s = t;
    return text.length;
  };
  g.sprintf = (dst: unknown, fmt: string, ...a: unknown[]) => write(dst, sprintf(String(fmt), a));
  g.snprintf = (dst: unknown, n: number, fmt: string, ...a: unknown[]) => write(dst, sprintf(String(fmt), a), Number(n));
  g.strlen = (s: unknown) => String(s ?? '').length;
  g.strcmp = (a: unknown, b: unknown) => { const x = String(a); const y = String(b); return x < y ? -1 : x > y ? 1 : 0; };
  g.strncmp = (a: unknown, b: unknown, n: number) => g.strcmp(String(a).slice(0, n), String(b).slice(0, n));
  g.strcpy = (dst: unknown, src: unknown) => { write(dst, String(src)); return dst; };
  g.strncpy = (dst: unknown, src: unknown, n: number) => { write(dst, String(src).slice(0, n)); return dst; };
  g.strcat = (dst: unknown, src: unknown) => { write(dst, String(dst) + String(src)); return dst; };
  g.memset = (dst: unknown, v: number) => { if (dst instanceof CBuf && v === 0) dst.s = ''; return dst; };
  g.strtol = (s: unknown, _end: unknown, base = 10) => { const n = parseInt(String(s), base); return Number.isNaN(n) ? 0 : n; };
  g.mutex = () => ({ lock: () => {}, unlock: () => {}, try_lock: () => true });
  g.static_assert = () => {};
  for (const f of ['mono12', 'mono15', 'mono20', 'mono30', 'mono40', 'mono60', 'prop20', 'prop30', 'prop40', 'prop60']) g[f] = f;
  // custom aliases commonly defined in team headers; assumed small/medium
  g.monoS = 'mono15';
  g.monoM = 'mono20';
  g.monoL = 'mono30';
  g.monoXL = 'mono40';
  // V5 has no proportional font smaller than 20px, so small and medium both map to it
  g.propS = 'prop20';
  g.propM = 'prop20';
  g.propL = 'prop30';
  g.to_string = (n: unknown) => (typeof n === 'number' && !Number.isInteger(n) ? n.toFixed(6) : typeof n === 'boolean' ? (n ? '1' : '0') : String(n));
  g.stoi = (s: unknown) => { const n = parseInt(String(s), 10); return Number.isNaN(n) ? 0 : n; };
  g.atoi = g.stoi;
  g.stod = (s: unknown) => { const n = parseFloat(String(s)); return Number.isNaN(n) ? 0 : n; };
  g.stof = g.stod;
  g.atof = g.stod;
  const str: any = (...a: unknown[]) => (a.length === 2 && typeof a[0] === 'number' ? String(a[1]).repeat(a[0] as number) : a.length ? String(a[0]) : '');
  str.npos = -1;
  g.string = str;
  g.abs = Math.abs; g.fabs = Math.abs; g.labs = Math.abs; g.sqrt = Math.sqrt; g.cbrt = Math.cbrt; g.pow = Math.pow;
  g.sin = Math.sin; g.cos = Math.cos; g.tan = Math.tan; g.asin = Math.asin; g.acos = Math.acos; g.atan = Math.atan; g.atan2 = Math.atan2;
  g.exp = Math.exp; g.log = Math.log; g.log10 = Math.log10; g.floor = Math.floor; g.ceil = Math.ceil; g.trunc = Math.trunc;
  g.round = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));
  g.fmod = (a: number, b: number) => a % b;
  g.min = (a: number, b: number) => Math.min(a, b); g.max = (a: number, b: number) => Math.max(a, b);
  g.fmin = g.min; g.fmax = g.max; g.hypot = Math.hypot;
  g.rand = () => Math.floor(Math.random() * 32768);
  g.srand = () => {};
  g.RAND_MAX = 32767; g.M_PI = Math.PI; g.INT_MAX = 2147483647; g.INT_MIN = -2147483648; g.FLT_MAX = 3.4028235e38; g.DBL_MAX = Number.MAX_VALUE;
  g.isdigit = (c: string) => /^[0-9]$/.test(String(c)); g.isalpha = (c: string) => /^[A-Za-z]$/.test(String(c));
  g.isalnum = (c: string) => /^[A-Za-z0-9]$/.test(String(c)); g.isspace = (c: string) => /^\s$/.test(String(c));
  g.toupper = (c: string) => String(c).toUpperCase(); g.tolower = (c: string) => String(c).toLowerCase();
  g.make_pair = (first: unknown, second: unknown) => ({ first, second });
  g.pair = (first: unknown, second: unknown) => ({ first, second });
  g.sort = async (first: unknown[], _last: unknown, cmp?: (a: unknown, b: unknown) => unknown) => { await sortInPlace(first, undefined, false, cmp); };
  g.reverse = (first: unknown[]) => { first.reverse(); };
  g.vector = (n?: number, v: unknown = 0) => (n === undefined ? [] : Array.from({ length: n }, () => v));
  g.array = g.vector;
  g.map = () => new PyDict();
  g.unordered_map = g.map;
  g.sizeof = (x: unknown) => (Array.isArray(x) ? x.length * 4 : 4);
  g.vexDelay = async (ms: number) => { await host.sleep(ms); };
  g.vexSystemTimeGet = () => host.now();
  g.clock = () => host.now();
  g.time = () => Math.floor(Date.now() / 1000);
  g.int = (x: unknown) => Math.trunc(Number(x)) || 0;
  g.double = (x: unknown) => Number(x);
  g.float = g.double;
  g.bool = (x: unknown) => !!x;
}

// ==================================================================== Python library
function installPython(g: Record<string, any>, host: EnvHost, out: (s: string) => void, flush: () => void): void {
  void flush;
  g.__name__ = '__main__';
  const kwOf = (a: unknown[]): { pos: unknown[]; kw: Record<string, any> } => {
    const l = a[a.length - 1];
    return l instanceof Kw ? { pos: a.slice(0, -1), kw: l.o } : { pos: a, kw: {} };
  };
  g.print = (...a: unknown[]) => {
    const { pos, kw } = kwOf(a);
    out(pos.map(pystr).join(kw.sep === undefined ? ' ' : String(kw.sep)) + (kw.end === undefined ? '\n' : String(kw.end)));
  };
  g.len = (x: any) => (typeof x === 'string' || Array.isArray(x) ? x.length : x instanceof PyDict ? Object.keys(x).length : (() => { throw new Error(`TypeError: object has no len()`); })());
  g.range = (a: number, b?: number, c = 1) => {
    const [s, e] = b === undefined ? [0, a] : [a, b];
    const r: number[] = [];
    if (c === 0) throw new Error('ValueError: range() arg 3 must not be zero');
    if (Math.abs((e - s) / c) > 1e7) throw new Error('range too large for the simulator');
    for (let i = s; c > 0 ? i < e : i > e; i += c) r.push(i);
    return r;
  };
  g.int = (x: unknown, base?: number) => {
    if (typeof x === 'string') { const n = parseInt(x.trim(), base ?? 10); if (Number.isNaN(n)) throw new Error(`ValueError: invalid literal for int(): ${pyRepr(x)}`); return n; }
    return Math.trunc(Number(x ?? 0));
  };
  g.float = (x: unknown) => { const n = Number(x ?? 0); if (Number.isNaN(n)) throw new Error(`ValueError: could not convert string to float: ${pyRepr(x)}`); return n; };
  g.str = (x: unknown) => (x === undefined ? '' : pystr(x));
  g.bool = (x: unknown) => !(x === null || x === undefined || x === false || x === 0 || x === '' || (Array.isArray(x) && !x.length));
  g.list = (x?: Iterable<unknown>) => (x === undefined ? [] : typeof x === 'string' ? Array.from(x) : x instanceof PyDict ? Object.keys(x) : Array.from(x));
  g.tuple = g.list;
  g.set = (x?: Iterable<unknown>) => (x === undefined ? [] : Array.from(new Set(typeof x === 'string' ? Array.from(x) : x)));
  g.dict = (...a: unknown[]) => { const d = new PyDict(); const { pos, kw } = kwOf(a); Object.assign(d, kw); if (pos[0]) Object.assign(d, pos[0]); return d; };
  g.abs = Math.abs;
  g.pow = Math.pow;
  g.round = (x: number, nd?: number) => pyRound(x, nd);
  g.chr = (n: number) => String.fromCharCode(n);
  g.ord = (c: string) => c.charCodeAt(0);
  g.divmod = (a: number, b: number) => [Math.floor(a / b), a - Math.floor(a / b) * b];
  g.isinstance = () => true;
  const num = (it: unknown[]): unknown[] => it;
  const extreme = (name: 'min' | 'max') => async (...a: unknown[]) => {
    const { pos, kw } = kwOf(a);
    const items = pos.length === 1 && (Array.isArray(pos[0]) || typeof pos[0] === 'string') ? Array.from(pos[0] as Iterable<unknown>) : pos;
    if (!items.length) { if ('default' in kw) return kw.default; throw new Error(`ValueError: ${name}() arg is an empty sequence`); }
    let best = items[0];
    let bestK = kw.key ? await kw.key(best) : best;
    for (const it of num(items).slice(1)) {
      const k = kw.key ? await kw.key(it) : it;
      if (name === 'min' ? (k as number) < (bestK as number) : (k as number) > (bestK as number)) { best = it; bestK = k; }
    }
    return best;
  };
  g.min = extreme('min');
  g.max = extreme('max');
  g.sum = (it: number[], start = 0) => Array.from(it).reduce((a, b) => a + b, start);
  g.sorted = async (it: Iterable<unknown>, ...a: unknown[]) => {
    const { kw } = kwOf(a);
    const l = typeof it === 'string' ? Array.from(it) : it instanceof PyDict ? Object.keys(it) : Array.from(it);
    await sortInPlace(l, kw.key, !!kw.reverse);
    return l;
  };
  g.reversed = (it: Iterable<unknown>) => Array.from(typeof it === 'string' ? Array.from(it) : it).reverse();
  g.enumerate = (it: Iterable<unknown>, start = 0) => Array.from(typeof it === 'string' ? Array.from(it) : it).map((v, i) => [i + start, v]);
  g.zip = (...its: unknown[][]) => { const n = Math.min(...its.map((i) => i.length)); return Array.from({ length: n }, (_, i) => its.map((l) => l[i])); };
  g.map = async (f: (x: unknown) => unknown, it: Iterable<unknown>) => { const r = []; for (const x of it) r.push(await f(x)); return r; };
  g.filter = async (f: ((x: unknown) => unknown) | null, it: Iterable<unknown>) => { const r = []; for (const x of it) if (f ? await f(x) : x) r.push(x); return r; };
  g.any = (it: Iterable<unknown>) => Array.from(it).some(Boolean);
  g.all = (it: Iterable<unknown>) => Array.from(it).every(Boolean);

  g.math = {
    pi: Math.PI, e: Math.E, inf: Infinity, tau: Math.PI * 2, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin,
    acos: Math.acos, atan: Math.atan, atan2: Math.atan2, floor: Math.floor, ceil: Math.ceil, fabs: Math.abs, pow: Math.pow, exp: Math.exp,
    log: (x: number, b?: number) => (b ? Math.log(x) / Math.log(b) : Math.log(x)), log10: Math.log10, hypot: Math.hypot,
    radians: (d: number) => (d * Math.PI) / 180, degrees: (r: number) => (r * 180) / Math.PI, isnan: Number.isNaN, trunc: Math.trunc,
  };
  g.random = {
    random: Math.random,
    randint: (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1)),
    uniform: (a: number, b: number) => a + Math.random() * (b - a),
    choice: (l: unknown[]) => l[Math.floor(Math.random() * l.length)],
    seed: () => {},
  };
  g.time = { sleep: async (s: number) => { await host.sleep(s * 1000); }, time: () => Date.now() / 1000 };
}
