import { Lang, compile } from '../lang/compile';
import { SyntaxErr } from '../lang/ast';
import { createEnv } from './env';
import { Ctx2D, BrainScreen } from './screen';
import { HelperHost, StopSignal, createHelpers, scopeProxy, stub } from './helpers';

export type RunState = 'idle' | 'running' | 'finished' | 'stopped' | 'error';
export type LogKind = 'out' | 'err' | 'warn' | 'info';

/** Turns raw JS errors from generated code into messages a VEX student can act on. */
export function friendlyError(e: unknown): string {
  if (e instanceof SyntaxErr) return e.line ? `Line ${e.line}: ${e.message}` : e.message;
  const msg = e instanceof Error ? e.message : String(e);
  let m = /^(.+) is not defined$/.exec(msg);
  if (m) return `'${m[1]}' is not defined - it is either misspelled, declared later, or not supported by the simulator.`;
  m = /^(.+) is not a function$/.exec(msg);
  if (m) return `Unknown or unsupported function: ${m[1]}`;
  m = /^Cannot read properties of (undefined|null) \(reading '(.+)'\)$/.exec(msg);
  if (m) return `Tried to use '.${m[2]}' on something that has no value (${m[1]}). Check array indexes and variable names.`;
  m = /^Assignment to constant variable/.exec(msg);
  if (m) return 'Tried to change a constant variable.';
  return msg;
}

export class Runtime implements HelperHost {
  stopped = true;
  state: RunState = 'idle';
  globals: Record<string, any> = {};
  screen: BrainScreen;
  competition: { auton?: unknown; driver?: unknown } = {};
  onLog: (text: string, kind: LogKind) => void = () => {};
  onState: (s: RunState) => void = () => {};

  private sleepers = new Set<{ t: ReturnType<typeof setTimeout>; rej: (e: Error) => void }>();
  private runId = 0;
  private t0 = 0;
  private brainObj: Record<string, any> = {};
  private flushOut: () => void = () => {};
  private lang: Lang = 'cpp';

  constructor(ctx: Ctx2D) {
    this.screen = new BrainScreen(ctx);
    this.screen.spawn = (fn, args) => this.spawn(fn, args);
  }

  now(): number { return performance.now() - this.t0; }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new StopSignal()); return; }
      const entry = {
        t: setTimeout(() => { this.sleepers.delete(entry); resolve(); }, Math.max(0, ms)),
        rej: reject,
      };
      this.sleepers.add(entry);
    });
  }

  requestStop(): void { this.stop('stopped'); }

  /** Ends the current run: pending waits reject, loops throw at their next iteration. */
  stop(final: RunState = 'stopped'): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sleepers) { clearTimeout(s.t); s.rej(new StopSignal()); }
    this.sleepers.clear();
    this.flushOut();
    this.setState(final);
  }

  private setState(s: RunState): void {
    this.state = s;
    this.onState(s);
  }

  spawn(fn: unknown, args: unknown[] = []): void {
    if (this.stopped || typeof fn !== 'function') return;
    const id = this.runId;
    void (async () => {
      try {
        await (fn as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        if (e instanceof StopSignal || id !== this.runId) return;
        this.onLog(friendlyError(e), 'err');
        this.stop('error');
      }
    })();
  }

  log(text: string, kind: LogKind = 'out'): void { this.onLog(text, kind); }

  makeDevice(type: string, name: string): unknown {
    if (type === 'brain') return this.globals.Brain;
    if (type === 'competition') return (this.globals.Competition ?? this.globals.competition)();
    return stub(name);
  }

  /** Run source code; resolves when the program ends (or is stopped). */
  async run(source: string, lang: Lang, entry?: string): Promise<void> {
    this.stop();
    const id = ++this.runId;
    this.lang = lang;
    this.t0 = performance.now();
    this.competition = {};
    this.screen.reset();
    this.screen.pythonMode = lang === 'py';

    const env = createEnv({
      screen: this.screen, lang, log: (t, k) => this.onLog(t, k ?? 'out'), sleep: (ms) => this.sleep(ms),
      spawn: (f, a) => this.spawn(f, a), now: () => this.now(), requestStop: () => this.requestStop(), competition: this.competition,
    });
    this.globals = env.globals;
    this.brainObj = env.brainObj;
    this.flushOut = env.flush;

    let program;
    try {
      program = compile(source, lang, Object.keys(env.globals), entry);
    } catch (e) {
      this.onLog(friendlyError(e), 'err');
      this.stopped = true;
      this.setState('error');
      return;
    }
    this.stopped = false;
    this.setState('running');
    try {
      // names the VEXcode project template provides (robot-config.h): defined for real programs, not worth a warning
      const TEMPLATE_NAMES = new Set(['Controller1', 'Controller2']);
      const missing: string[] = [];
      let flush: ReturnType<typeof setTimeout> | undefined;
      const scope = scopeProxy(env.globals, (name) => {
        if (TEMPLATE_NAMES.has(name)) return;
        missing.push(name);
        // one summary line instead of one warning per name
        if (flush === undefined) {
          flush = setTimeout(() => {
            flush = undefined;
            this.onLog(`Not defined in this file: ${missing.splice(0).join(', ')}. These come from your project's other files, so placeholder values are used.`, 'info');
          }, 50);
        }
      });
      await program(createHelpers(this), scope);
      // starting a helper like DisplayAutoSelector() simulates a main() that carries on idling afterwards:
      // touch callbacks and background threads must stay alive until Stop. A real main() ending ends the program.
      if (entry && entry !== 'main') return;
      if (id === this.runId && !this.stopped) {
        this.stopped = true;
        env.flush();
        this.setState('finished');
      }
    } catch (e) {
      if (e instanceof StopSignal || id !== this.runId) return;
      this.onLog(friendlyError(e), 'err');
      this.stop('error');
    }
  }

  runAutonomous(): void { this.spawn(this.competition.auton); }
  runDriverControl(): void { this.spawn(this.competition.driver); }
}
