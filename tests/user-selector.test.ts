import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Runtime } from '../src/sim/runtime';
import { Ctx2D } from '../src/sim/screen';
import { guessEntry, listEntries } from '../src/lang/compile';

const SRC = readFileSync(new URL('./fixtures/screen_gui.cpp', import.meta.url), 'utf8');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mockCtx(ops: string[]): Ctx2D {
  const ctx: Ctx2D = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    fillRect: (x, y, w, h) => { ops.push(`fillRect ${x} ${y} ${w} ${h} ${ctx.fillStyle}`); },
    strokeRect: () => {}, clearRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    arc: (x, y, r) => { ops.push(`arc ${x} ${y} ${r}`); }, fill: () => {}, stroke: () => {},
    fillText: (t) => { ops.push(`text ${t}`); },
    measureText: () => ({ width: 10 }),
  };
  return ctx;
}

async function tap(rt: Runtime, x: number, y: number): Promise<void> {
  rt.screen.touchDown(x, y);
  await sleep(160);
  rt.screen.touchUp();
  await sleep(120);
}

describe('real-world auto selector (macros, operators, char buffers, static locals, missing headers)', () => {
  it('finds a sensible entry point', () => {
    const entries = listEntries(SRC, 'cpp');
    expect(entries).toContain('DisplayAutoSelector');
    expect(guessEntry(entries)).toBe('DisplayAutoSelector');
  });

  it('draws the selector, switches tabs and locks in an auton', async () => {
    const ops: string[] = [];
    const logs: string[] = [];
    const rt = new Runtime(mockCtx(ops));
    rt.onLog = (t, k) => logs.push(`${k}:${t}`);
    const done = rt.run(SRC, 'cpp', 'DisplayAutoSelector');
    await sleep(300);
    expect(logs.filter((l) => l.startsWith('err'))).toEqual([]);
    const text = (): string[] => ops.filter((o) => o.startsWith('text ')).map((o) => o.slice(5));
    expect(text().join('')).toContain('QUALS');
    expect(text().join('')).toContain('4PinsNear'); // the mock records glyphs, spaces are not drawn

    ops.length = 0;
    await tap(rt, 49, 100); // ELIMS tab (tab column, second tab)
    expect(logs.filter((l) => l.startsWith('err'))).toEqual([]);
    expect(text().join('')).toContain('nothing');

    ops.length = 0;
    await tap(rt, 340, 220); // CONFIRM
    expect(text().join('')).toContain('AUTONLOCKEDIN');
    expect(logs.filter((l) => l.startsWith('err'))).toEqual([]);

    rt.stop();
    await done;
  });
});
