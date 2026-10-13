import type { Lang } from './lang/compile';

/** Shown only the first time the app opens, before anything has been pasted or saved. */
export const STARTER_CODE = `#include "vex.h"
using namespace vex;

brain Brain;

int main() {
  Brain.Screen.setFont(fontType::mono20);
  Brain.Screen.setFillColor(color::blue);
  Brain.Screen.drawRectangle(20, 20, 200, 80);
  Brain.Screen.setPenColor(color::white);
  Brain.Screen.printAt(40, 66, "Hello, Brain!");

  while (true) {
    Brain.Screen.setCursor(10, 1);
    Brain.Screen.print("Touch: %d, %d   ", Brain.Screen.xPosition(), Brain.Screen.yPosition());
    wait(50, msec);
  }
}
`;

/** Cheap guess so a pasted program does not need the language picked by hand. */
export function detectLanguage(code: string): Lang {
  if (/#include|\bint\s+main\s*\(|\bvoid\s+\w+\s*\(.*\)\s*\{|;\s*$/m.test(code)) return 'cpp';
  if (/^\s*(def |import |from |class |while True|for .+ in )|\bprint\(|:\s*$/m.test(code)) return 'py';
  return 'cpp';
}
