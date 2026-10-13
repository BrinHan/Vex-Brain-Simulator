import { describe, expect, it } from 'vitest';
import { Runtime } from '../src/sim/runtime';
import { Ctx2D } from '../src/sim/screen';
import { Lang } from '../src/lang/compile';

function mockCtx(ops: string[]): Ctx2D {
  const ctx: Ctx2D = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    fillRect: (x, y, w, h) => { ops.push(`fillRect ${x} ${y} ${w} ${h} ${ctx.fillStyle}`); },
    strokeRect: (x, y, w, h) => { ops.push(`strokeRect ${x} ${y} ${w} ${h} ${ctx.strokeStyle}`); },
    clearRect: () => { ops.push('clearRect'); },
    beginPath: () => {}, moveTo: () => {}, lineTo: (x, y) => { ops.push(`lineTo ${x} ${y}`); },
    arc: (x, y, r) => { ops.push(`arc ${x} ${y} ${r}`); },
    fill: () => {}, stroke: () => {},
    fillText: (t, x, y) => { ops.push(`text ${t} ${Math.round(x)} ${y}`); },
    measureText: () => ({ width: 10 }),
  };
  return ctx;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function exec(src: string, lang: Lang, ms = 60, during?: (rt: Runtime) => Promise<void> | void) {
  const ops: string[] = [];
  const logs: string[] = [];
  const rt = new Runtime(mockCtx(ops));
  rt.onLog = (t, k) => logs.push(`${k}:${t}`);
  const p = rt.run(src, lang);
  if (during) { await sleep(ms / 2); await during(rt); }
  await sleep(ms);
  rt.stop();
  await p;
  return { ops, logs, rt };
}

describe('C++', () => {
  it('draws shapes and text', async () => {
    const { ops, logs } = await exec(`
      #include "vex.h"
      using namespace vex;
      brain Brain;
      int main() {
        Brain.Screen.setFillColor(vex::color::red);
        Brain.Screen.drawRectangle(10, 20, 100, 50);
        Brain.Screen.printAt(5, 100, "Hi");
        return 0;
      }`, 'cpp');
    expect(logs.filter((l) => l.startsWith('err'))).toEqual([]);
    expect(ops).toContain('fillRect 10 20 100 50 rgb(255, 0, 0)');
    expect(ops).toContain('strokeRect 10.5 20.5 99 49 rgb(255, 255, 255)');
    expect(ops.some((o) => o.startsWith('text H '))).toBe(true);
  });

  it('uses C integer division and printf', async () => {
    const { logs } = await exec(`
      int half(int v) { return v / 2; }
      int main() {
        double d = 7 / 2.0;
        printf("%d %d %.1f %s|%5d|\\n", 7 / 2, half(9), d, "ok", 42);
        return 0;
      }`, 'cpp');
    expect(logs).toEqual(['out:3 4 3.5 ok|   42|']);
  });

  it('runs a touch-driven auto selector with structs', async () => {
    const src = `
      #include "vex.h"
      using namespace vex;
      brain Brain;
      struct Button { int x, y, w, h; std::string label; vex::color col; };
      Button buttons[2] = { {10, 10, 100, 50, "Red", vex::color::red}, {130, 10, 100, 50, "Blue", vex::color::blue} };
      int selected = -1;
      void draw() {
        Brain.Screen.clearScreen();
        for (int i = 0; i < 2; i++) {
          Brain.Screen.drawRectangle(buttons[i].x, buttons[i].y, buttons[i].w, buttons[i].h, buttons[i].col);
          Brain.Screen.printAt(buttons[i].x + 5, buttons[i].y + 30, buttons[i].label.c_str());
        }
      }
      int main() {
        draw();
        while (true) {
          if (Brain.Screen.pressing()) {
            int px = Brain.Screen.xPosition();
            int py = Brain.Screen.yPosition();
            for (int i = 0; i < 2; i++) {
              if (px >= buttons[i].x && px <= buttons[i].x + buttons[i].w && py >= buttons[i].y && py <= buttons[i].y + buttons[i].h) {
                selected = i;
                printf("selected %d\\n", selected);
              }
            }
          }
          vex::task::sleep(20);
        }
      }`;
    const { ops, logs } = await exec(src, 'cpp', 120, (rt) => rt.screen.touchDown(140, 30));
    expect(logs.filter((l) => l.startsWith('err'))).toEqual([]);
    expect(ops).toContain('fillRect 10 10 100 50 rgb(255, 0, 0)');
    expect(ops).toContain('fillRect 130 10 100 50 rgb(0, 0, 255)');
    expect(logs).toContain('out:selected 1');
    expect(logs).not.toContain('out:selected 0');
  });

  it('supports pressed() callbacks, classes and switch', async () => {
    const src = `
      brain Brain;
      class Counter {
       public:
        int n;
        Counter(int start) : n(start) {}
        void bump() { n++; }
        int get() const { return n; }
      };
      Counter c(5);
      void onPress() { c.bump(); }
      int main() {
        Brain.Screen.pressed(onPress);
        wait(150, msec);
        switch (c.get()) {
          case 6: printf("six\\n"); break;
          default: printf("other %d\\n", c.get());
        }
      }`;
    const { logs } = await exec(src, 'cpp', 300, (rt) => { rt.screen.touchDown(1, 1); rt.screen.touchUp(); });
    expect(logs).toContain('out:six');
  });

  it('reports syntax errors with a line number', async () => {
    const { logs } = await exec(`int main() {\n  int x = ;\n}`, 'cpp');
    expect(logs[0]).toMatch(/^err:Line 2:/);
  });

  it('reports unknown functions', async () => {
    const { logs } = await exec(`int main() { Brain.Screen.nope(); }`, 'cpp');
    expect(logs[0]).toMatch(/err:.*(not defined|Unknown)/);
  });

  it('reports runtime errors with the line they happened on', async () => {
    const { logs } = await exec(`int f(int d) {\n  return 10 / d;\n}\nint main() {\n  int a = 1;\n  f(0);\n}`, 'cpp');
    expect(logs[0]).toMatch(/^err:Line 2: Division by zero/);
  });

  it('reports the line of an error inside a thread', async () => {
    const src = `void worker() {\n  wait(10, msec);\n  Brain.Screen.nope();\n}\nint main() {\n  thread t(worker);\n  while (true) wait(5, msec);\n}`;
    const { logs } = await exec(src, 'cpp', 120);
    expect(logs.find((l) => l.startsWith('err:'))).toMatch(/^err:Line 3:/);
  });
});

describe('Controller', () => {
  it('reads sticks and buttons and runs pressed() callbacks in C++', async () => {
    const src = `#include "vex.h"
using namespace vex;
controller Controller1 = controller(primary);
void onA() { printf("A pressed\\n"); }
int main() {
  Controller1.ButtonA.pressed(onA);
  waitUntil(Controller1.ButtonL1.pressing());
  printf("axis3=%d\\n", Controller1.Axis3.position(percent));
  Controller1.Screen.setCursor(2, 3);
  Controller1.Screen.print("Hi %d", 7);
}`;
    const { logs, rt } = await exec(src, 'cpp', 150, async (rt) => {
      rt.controller.setButton('A', true);
      rt.controller.setAxis(3, 64);
      await sleep(20);
      rt.controller.setButton('L1', true);
    });
    expect(logs).toContain('out:A pressed');
    expect(logs).toContain('out:axis3=64');
    expect(rt.controllerScreen.rows[1]).toBe('  Hi 7');
    rt.controller.releaseAll();
  });

  it('works with the Python names and the template Controller1', async () => {
    const src = `from vex import *
controller_1 = Controller(PRIMARY)
while not controller_1.buttonR2.pressing():
    wait(5, MSEC)
controller_1.screen.print("x", controller_1.axis1.position())
`;
    const { rt } = await exec(src, 'py', 120, (rt) => { rt.controller.setAxis(1, -50); rt.controller.setButton('R2', true); });
    expect(rt.controllerScreen.rows[0]).toBe('x -50');
    rt.controller.releaseAll();
  });
});

describe('Python', () => {
  it('reports runtime errors with the line they happened on', async () => {
    const { logs } = await exec(`from vex import *\ntext = "abc"\n\ndef parse():\n    return int(text)\n\nparse()\n`, 'py');
    expect(logs[0]).toMatch(/^err:Line 5: ValueError/);
  });

  it('draws with keyword arguments and f-strings', async () => {
    const { ops, logs } = await exec(`
from vex import *
brain = Brain()
brain.screen.set_fill_color(Color.GREEN)
brain.screen.draw_rectangle(0, 0, 50, 30)
brain.screen.draw_circle(100, 100, 20, Color(255, 0, 255))
brain.screen.print_at("Hello", x=10, y=100)
n = 7
print(f"n={n:03d} half={n/2:.1f} {n//2} {n % 4}")
`, 'py');
    expect(logs).toEqual(['out:n=007 half=3.5 3 3']);
    expect(ops).toContain('fillRect 0 0 50 30 rgb(0, 255, 0)');
    expect(ops).toContain('arc 100.5 100.5 20');
    expect(ops.some((o) => o.startsWith('text H '))).toBe(true);
  });

  it('runs a touch-driven auto selector', async () => {
    const src = `
from vex import *
brain = Brain()
buttons = [(10, 10, 100, 50, "Red", Color.RED), (130, 10, 100, 50, "Blue", Color.BLUE)]
selected = -1
def draw():
    brain.screen.clear_screen()
    for b in buttons:
        brain.screen.draw_rectangle(b[0], b[1], b[2], b[3], b[5])
        brain.screen.print_at(b[4], x=b[0] + 5, y=b[1] + 30)
draw()
while True:
    if brain.screen.pressing():
        px = brain.screen.x_position()
        py = brain.screen.y_position()
        for i in range(len(buttons)):
            b = buttons[i]
            if b[0] <= px <= b[0] + b[2] and b[1] <= py <= b[1] + b[3]:
                selected = i
                print(f"selected {selected}")
    wait(20, MSEC)
`;
    const { ops, logs } = await exec(src, 'py', 120, (rt) => rt.screen.touchDown(20, 30));
    expect(logs.filter((l) => l.startsWith('err'))).toEqual([]);
    expect(ops).toContain('fillRect 130 10 100 50 rgb(0, 0, 255)');
    expect(logs).toContain('out:selected 0');
    expect(logs).not.toContain('out:selected 1');
  });

  it('supports classes, globals, comprehensions and callbacks', async () => {
    const { logs } = await exec(`
class Counter:
    def __init__(self, start):
        self.n = start
    def bump(self):
        self.n += 1
        return self.n

total = 0
def add(k=1):
    global total
    total += k

def pressed():
    add(10)

c = Counter(3)
c.bump()
squares = [x * x for x in range(4) if x != 2]
brain = Brain()
brain.screen.pressed(pressed)
wait(300, MSEC)
print(c.n, squares, total, "a,b".split(","), len("xyz"), 7 // 2, -7 // 2, round(2.5))
`, 'py', 400, (rt) => { rt.screen.touchDown(1, 1); rt.screen.touchUp(); });
    expect(logs).toEqual(['out:4 [0, 1, 9] 10 [\'a\', \'b\'] 3 3 -4 2']);
  });

  it('reports indentation errors', async () => {
    const { logs } = await exec(`def f():\nprint(1)\n`, 'py');
    expect(logs[0]).toMatch(/^err:Line \d+:/);
  });
});
