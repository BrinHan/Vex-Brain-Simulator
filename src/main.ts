import './style.css';
import { Runtime, RunState, LogKind } from './sim/runtime';
import { STARTER_CODE, detectLanguage } from './examples';
import { guessEntry, listEntries, type Lang } from './lang/compile';
import { SCREEN_H, SCREEN_W } from './sim/screen';
import { highlight } from './highlight';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('screen');
const codeEl = $<HTMLTextAreaElement>('code');
const hlEl = $<HTMLPreElement>('hl');
const gutter = $<HTMLDivElement>('gutter');
const consoleEl = $<HTMLDivElement>('console');
const langSel = $<HTMLSelectElement>('lang');
const runBtn = $<HTMLButtonElement>('run');
const stopBtn = $<HTMLButtonElement>('stop');
const statusEl = $<HTMLSpanElement>('status');
const touchEl = $<HTMLSpanElement>('touch');
const compEl = $<HTMLSpanElement>('comp');
const viewport = $<HTMLDivElement>('viewport');

// Programs draw (in 480x240 coordinates) into a hidden 4x buffer. Every frame it is copied to the visible canvas at
// exactly the size it occupies on screen (in device pixels), so it is sharp at any zoom or display density.
const RENDER_SCALE = 4;
const buffer = document.createElement('canvas');
buffer.width = SCREEN_W * RENDER_SCALE;
buffer.height = SCREEN_H * RENDER_SCALE;
const ctx = buffer.getContext('2d') as CanvasRenderingContext2D;
ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
const display = canvas.getContext('2d') as CanvasRenderingContext2D;

function present(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
  const h = Math.round(w / 2);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  display.imageSmoothingEnabled = true;
  display.imageSmoothingQuality = 'high';
  display.drawImage(buffer, 0, 0, w, h);
  requestAnimationFrame(present);
}
requestAnimationFrame(present);

const rt = new Runtime(ctx);

// ---------------------------------------------------------------- persistence (best effort)
const store = {
  get(k: string): string | null { try { return localStorage.getItem(`vexsim.${k}`); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(`vexsim.${k}`, v); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------- editor: highlighting + line numbers
let errLine = 0;
let fileName = '';

function currentLang(): Lang {
  return langSel.value === 'auto' ? detectLanguage(codeEl.value) : (langSel.value as Lang);
}

function activeLine(): number {
  return codeEl.value.slice(0, codeEl.selectionStart).split('\n').length;
}

function renderGutter(): void {
  const n = codeEl.value.split('\n').length;
  const cur = activeLine();
  const lineStart = codeEl.value.lastIndexOf('\n', codeEl.selectionStart - 1) + 1;
  $('cursor-pos').textContent = `Ln ${cur}, Col ${codeEl.selectionStart - lineStart + 1}`;
  let html = '';
  for (let i = 1; i <= n; i++) html += `<div${i === errLine ? ' class="bad"' : i === cur ? ' class="cur"' : ''}>${i}</div>`;
  gutter.innerHTML = html;
  gutter.scrollTop = codeEl.scrollTop;
}

function renderCode(): void {
  hlEl.innerHTML = highlight(codeEl.value, currentLang()) + '\n';
  syncScroll();
  $('tab-name').textContent = fileName || (currentLang() === 'cpp' ? 'main.cpp' : 'main.py');
  $('lang-label').textContent = currentLang() === 'cpp' ? 'C++' : 'Python';
}

function syncScroll(): void {
  hlEl.scrollTop = codeEl.scrollTop;
  hlEl.scrollLeft = codeEl.scrollLeft;
  gutter.scrollTop = codeEl.scrollTop;
}

let pending = false;
function refresh(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; renderCode(); renderGutter(); });
}

// ---------------------------------------------------------------- entry point (C++ programs without main)
const entrySel = $<HTMLSelectElement>('entry');

function refreshEntries(): void {
  const entries = currentLang() === 'cpp' ? listEntries(codeEl.value, 'cpp') : [];
  const previous = entrySel.value;
  entrySel.textContent = '';
  for (const n of entries) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = `${n}()`;
    entrySel.appendChild(o);
  }
  if (entries.length) entrySel.value = entries.includes(previous) ? previous : (guessEntry(entries) ?? entries[0]);
}

/** The sub-bar under the preview toolbar only exists while the program uses Competition callbacks. */
function syncSubbar(): void {
  $('subbar').hidden = compEl.hidden;
  applyView();
}

let entryTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleEntries(): void {
  if (entryTimer !== undefined) clearTimeout(entryTimer);
  entryTimer = setTimeout(refreshEntries, 400);
}

codeEl.addEventListener('input', () => {
  errLine = 0;
  store.set('code', codeEl.value);
  refresh();
  scheduleEntries();
});
codeEl.addEventListener('scroll', syncScroll);
// the wheel also works over the line numbers
gutter.addEventListener('wheel', (e) => { e.preventDefault(); codeEl.scrollTop += e.deltaY; }, { passive: false });
for (const ev of ['keyup', 'click', 'focus'] as const) codeEl.addEventListener(ev, () => renderGutter());
codeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const pad = currentLang() === 'py' ? '    ' : '  ';
    codeEl.setRangeText(pad, codeEl.selectionStart, codeEl.selectionEnd, 'end');
    codeEl.dispatchEvent(new Event('input'));
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void run();
  }
});
langSel.addEventListener('change', () => { store.set('lang', langSel.value); refreshEntries(); refresh(); });

// ---------------------------------------------------------------- files: open / drop / save
function loadSource(name: string, text: string): void {
  fileName = name;
  codeEl.value = text;
  langSel.value = /\.py$/i.test(name) ? 'py' : 'cpp';
  store.set('lang', langSel.value);
  store.set('code', text);
  errLine = 0;
  refresh();
  refreshEntries();
  void run();
}
function readFile(f: File | undefined): void {
  if (f) void f.text().then((t) => loadSource(f.name, t));
}
const fileInput = $<HTMLInputElement>('file');
$<HTMLButtonElement>('open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { readFile(fileInput.files?.[0]); fileInput.value = ''; });
codeEl.addEventListener('dragover', (e) => e.preventDefault());
codeEl.addEventListener('drop', (e) => { e.preventDefault(); readFile(e.dataTransfer?.files[0]); });

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$<HTMLButtonElement>('save').addEventListener('click', () => {
  const lang = currentLang();
  download(new Blob([codeEl.value], { type: 'text/plain' }), fileName || (lang === 'cpp' ? 'main.cpp' : 'main.py'));
});

// ---------------------------------------------------------------- terminal
const terminal = $<HTMLDivElement>('terminal');
const badge = $<HTMLSpanElement>('term-badge');
const toggleBtn = $<HTMLButtonElement>('term-toggle');
let errorCount = 0;

function setCollapsed(c: boolean): void {
  terminal.classList.toggle('collapsed', c);
  toggleBtn.setAttribute('aria-expanded', String(!c));
  toggleBtn.title = c ? 'Expand terminal' : 'Collapse terminal';
  store.set('term', c ? 'closed' : 'open');
}
$<HTMLDivElement>('term-head').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#clear-console')) return;
  setCollapsed(!terminal.classList.contains('collapsed'));
});

function log(text: string, kind: LogKind = 'out'): void {
  const line = document.createElement('div');
  if (kind !== 'out') line.className = kind;
  line.textContent = text;
  consoleEl.appendChild(line);
  while (consoleEl.childElementCount > 500) consoleEl.firstElementChild?.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
  if (kind === 'err') {
    errorCount++;
    badge.textContent = String(errorCount);
    badge.hidden = false;
    setCollapsed(false);
    const m = /^Line (\d+):/.exec(text);
    if (m) { errLine = Number(m[1]); renderGutter(); }
  }
}
function clearConsole(): void {
  consoleEl.textContent = '';
  errorCount = 0;
  badge.hidden = true;
}
$<HTMLButtonElement>('clear-console').addEventListener('click', clearConsole);

// ---------------------------------------------------------------- run control
const STATUS_TEXT: Record<RunState, string> = {
  idle: 'Idle', running: 'Running', finished: 'Program ended', stopped: 'Stopped', error: 'Error',
};
let runLang: Lang = 'cpp';

rt.onLog = log;
rt.onState = (s) => {
  statusEl.className = `status ${s}`;
  statusEl.textContent = s === 'running' ? `Running (${runLang === 'cpp' ? 'C++' : 'Python'})` : STATUS_TEXT[s];
  stopBtn.disabled = s !== 'running';
  runBtn.disabled = s === 'running';
  if (s !== 'running') updateComp();
};

async function run(): Promise<void> {
  runLang = currentLang();
  clearConsole();
  errLine = 0;
  renderGutter();
  if (langSel.value === 'auto') log(`Detected ${runLang === 'cpp' ? 'C++' : 'Python'}`, 'info');
  refreshEntries();
  const entry = runLang === 'cpp' && entrySel.value ? entrySel.value : undefined;
  if (entry && entry !== 'main') log(`No main() to start from - running ${entry}() and keeping the program alive until you press Stop.`, 'info');
  await rt.run(codeEl.value, runLang, entry);
}

runBtn.addEventListener('click', () => void run());
stopBtn.addEventListener('click', () => rt.stop());

function updateComp(): void {
  const has = !!(rt.competition.auton || rt.competition.driver);
  if (compEl.hidden === has) { compEl.hidden = !has; syncSubbar(); }
  $<HTMLButtonElement>('run-auton').disabled = !rt.competition.auton || rt.state !== 'running';
  $<HTMLButtonElement>('run-driver').disabled = !rt.competition.driver || rt.state !== 'running';
}
setInterval(updateComp, 400);
$<HTMLButtonElement>('run-auton').addEventListener('click', () => rt.runAutonomous());
$<HTMLButtonElement>('run-driver').addEventListener('click', () => rt.runDriverControl());

// ---------------------------------------------------------------- touch
function toScreen(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) * SCREEN_W) / r.width, ((e.clientY - r.top) * SCREEN_H) / r.height];
}
function showTouch(x: number, y: number, down: boolean): void {
  touchEl.textContent = `Touch: ${down ? '' : 'last '}${Math.round(x)}, ${Math.round(y)}`;
}
// A real finger press lasts at least ~100 ms; hold very short clicks so polling loops (wait(20)) can see them.
const MIN_TOUCH_MS = 100;
let touchStart = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function liftFinger(): void {
  rt.screen.touchUp();
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId); // keep tracking even if the pointer leaves the screen
  const [x, y] = toScreen(e);
  if (releaseTimer !== undefined) { clearTimeout(releaseTimer); liftFinger(); releaseTimer = undefined; }
  touchStart = performance.now();
  rt.screen.touchDown(x, y); // respond on press, not on release
  showTouch(x, y, true);
});
canvas.addEventListener('pointermove', (e) => {
  const [x, y] = toScreen(e);
  if (rt.screen.touching) { rt.screen.touchMove(x, y); showTouch(x, y, true); } else showTouch(x, y, false);
});
const release = (): void => {
  const wait = MIN_TOUCH_MS - (performance.now() - touchStart);
  if (wait <= 0) { liftFinger(); return; }
  releaseTimer = setTimeout(() => { releaseTimer = undefined; liftFinger(); }, wait);
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

// ---------------------------------------------------------------- viewport: Fit / Reset View / Snapshot
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const savedView = Number(store.get('view'));
let zoom: 'fit' | number = savedView > 0 ? savedView : 'fit';
const brainEl = $<HTMLDivElement>('brain');

/** Fit: the largest 2:1 screen that leaves the frame and padding inside the viewport. */
function applyView(): void {
  if (zoom !== 'fit') canvas.style.width = `${SCREEN_W * zoom}px`;
  else {
    const cs = getComputedStyle(viewport);
    const frame = brainEl.offsetWidth - canvas.offsetWidth; // border + padding around the canvas
    const availW = viewport.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - frame;
    const availH = viewport.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - frame;
    canvas.style.width = `${Math.max(120, Math.floor(Math.min(availW, availH * 2)))}px`;
  }
  $('zoom-label').textContent = `${Math.round((canvas.clientWidth / SCREEN_W) * 100)}%`;
}
function setZoom(z: 'fit' | number): void {
  zoom = z;
  store.set('view', String(z));
  applyView();
}
function stepZoom(dir: 1 | -1): void {
  const cur = canvas.clientWidth / SCREEN_W;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.01);
  if (next !== undefined) setZoom(next);
}
$<HTMLButtonElement>('zoom-in').addEventListener('click', () => stepZoom(1));
$<HTMLButtonElement>('zoom-out').addEventListener('click', () => stepZoom(-1));
$<HTMLButtonElement>('zoom-label').addEventListener('click', () => setZoom('fit'));
viewport.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  stepZoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });
new ResizeObserver(applyView).observe(viewport);

// ---------------------------------------------------------------- layout: Code | Split | Preview
type Layout = 'code' | 'split' | 'preview';
const workbench = $<HTMLElement>('workbench');
const layoutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#layout button'));
let layout: Layout = 'split';

function setLayout(l: Layout): void {
  layout = l;
  workbench.dataset.layout = l;
  for (const b of layoutButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === l));
  store.set('layout', l);
  if (l !== 'preview') { renderCode(); renderGutter(); } // the editor was hidden: re-sync scroll
  applyView();
}
for (const b of layoutButtons) b.addEventListener('click', () => setLayout(b.dataset.mode as Layout));
// Ctrl+B tucks the code away (and brings it back), like a sidebar
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'b' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    setLayout(layout === 'preview' ? 'split' : 'preview');
  }
});
// an error while the code is tucked away: the status bar says so, and clicking it reveals the terminal
statusEl.addEventListener('click', () => { if (rt.state === 'error' && layout === 'preview') setLayout('split'); });

window.addEventListener('beforeunload', () => rt.stop());

// ---------------------------------------------------------------- startup
codeEl.value = store.get('code') ?? STARTER_CODE;
langSel.value = store.get('lang') ?? (store.get('code') ? 'auto' : 'cpp');
if (!['auto', 'cpp', 'py'].includes(langSel.value)) langSel.value = 'auto';
setCollapsed(store.get('term') === 'closed');
const savedLayout = store.get('layout');
setLayout(savedLayout === 'code' || savedLayout === 'preview' ? savedLayout : 'split');
renderCode();
renderGutter();
refreshEntries();

// the Brain fonts must be ready before the first frame is drawn, or the canvas silently uses a fallback face
void Promise.all([
  document.fonts.load('16px "Brain Mono"'),
  document.fonts.load('16px "Brain Prop"'),
]).catch(() => {}).finally(() => void run());
