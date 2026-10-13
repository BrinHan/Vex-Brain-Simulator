# VEX Brain Simulator

Paste VEXcode **C++** or **Python** that draws on the V5 Brain screen, press **Run**, and see what it would look
like on a real Brain (480×240 touchscreen). Click the screen to touch it, so auto selectors work too.

It runs in the browser and as a desktop app (Electron) from the same TypeScript code.

## Run it

```bash
npm install
npm run dev          # web app at http://localhost:5173
npm run desktop      # build + open the Electron desktop app
npm run dist         # installer for your OS (electron-builder)
npm test             # engine tests
```

`npm run build` outputs a static site to `dist/` that can be hosted anywhere.

## How it works

Your code is not run by a real compiler. It is parsed by a C++ or Python front-end into one shared AST,
translated to JavaScript and run against a simulated VEX API:

```
src/lang/   cpp-lexer/cpp-parser, py-parser  ->  ast  ->  codegen  ->  JS
src/sim/    screen (Brain.Screen), env (VEX globals), helpers (C++/Python semantics), runtime (run/stop/tasks)
src/        main.ts (UI), examples.ts
```

Every call is awaited, so `wait()` really waits, `while(true)` loops don't freeze the page, and **Stop** works.

## Supported VEX API

`Brain.Screen` (C++ camelCase and Python snake_case): `clearScreen`, `clearLine`/`clear_row`, `setCursor`, `row`, `column`,
`newLine`/`next_row`, `setPenColor`, `setFillColor`, `setPenWidth`, `setFont`, `setOrigin`, `drawPixel`, `drawLine`,
`drawRectangle`, `drawCircle`, `print`, `printAt`/`print_at` (printf-style in C++, `sep`/`precision`/`x`/`y`/`opaque`
keywords in Python), `getStringWidth`, `pressing`, `xPosition`, `yPosition`, `pressed`, `released`, `render`.
Also `color` / `Color` (constants, RGB, hex, hsv), `fontType` / `FontType`, `wait`, `thread`/`Thread`, `task`,
`Brain.Timer`, `Brain.Battery`, `waitUntil`, `Competition` callbacks (buttons appear under the screen), `printf` and
`std::cout` / Python `print` (shown in the Console).

Motors, sensors, the controller etc. are accepted and ignored so real programs still run.

## Uploading real project files

Use **Open file…** (or drop a `.cpp`/`.hpp`/`.py` file on the editor). Real files usually aren't whole programs, so:

- No `main()`? Pick the function to run in **Start with** (it guesses, e.g. `DisplayAutoSelector()`); the run then stays
  alive until Stop so touch handlers and background threads keep working.
- Names defined in headers you didn't paste (`Gyro`, `Controller1`, `currentTab`, `monoS`...) become harmless stub
  values and are listed once as a warning in the Console, so genuine typos are still visible.
  `monoS` / `monoM` are assumed to be mono15 / mono20.
- Supported C++ beyond basics: `#define` macros, `static` locals, `char` buffers with `snprintf`/`strlen`,
  `operator==`-style overloads, `enum`, structs/classes with constructors, `vex::thread`, `vex::mutex`.

## Known limits

- C++: no templates, operator overloading, pointers/`new`, or references to primitives (`int&`); it is a practical
  subset aimed at screen/UI code. Python: no nested comprehensions, `match`, or generators.
- `printAt(x, y)` treats `y` as the text baseline; verify against a real Brain and tweak `ASCENT` in
  `src/sim/screen.ts` if needed. Default font is mono20 (10×20 px, 12 rows × 48 columns).
- Text is drawn with a browser font, so glyph shapes differ from the Brain's font. Layout (sizes/positions) matches.
- Python floats and ints are both JS numbers, so `print(5.0)` shows `5`.
- Runtime errors show the message but not a line number (syntax errors do).
