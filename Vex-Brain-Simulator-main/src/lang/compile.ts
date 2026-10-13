import { Program, SyntaxErr } from './ast';
import { generate } from './codegen';
import { parseCpp } from './cpp-parser';
import { parsePython } from './py-parser';

export type Lang = 'cpp' | 'py';
export type CompiledProgram = (helpers: Record<string, any>, globals: Record<string, any>) => Promise<void>;

export function parse(source: string, lang: Lang): Program {
  return lang === 'cpp' ? parseCpp(source) : parsePython(source);
}

/** Source -> generated JavaScript (exposed for debugging and tests). */
export function toJs(source: string, lang: Lang, globalNames: string[], entry?: string): string {
  return generate(parse(source, lang), globalNames, entry);
}

/**
 * C++ functions that can be started without arguments: `main` first, then non-static (public) functions,
 * then static helpers. Empty for python or on a syntax error.
 */
export function listEntries(source: string, lang: Lang): string[] {
  if (lang !== 'cpp') return [];
  try {
    const fns = parse(source, lang).body.filter((s) => s.k === 'func' && s.params.length === 0) as { name: string; ret?: { isStatic?: boolean } }[];
    const rank = (f: { name: string; ret?: { isStatic?: boolean } }): number => (f.name === 'main' ? 0 : f.ret?.isStatic ? 2 : 1);
    return [...new Set([...fns].sort((a, b) => rank(a) - rank(b)).map((f) => f.name))];
  } catch {
    return [];
  }
}

/** Best default entry: main(), else a public function that looks like a screen/selector routine. */
export function guessEntry(entries: string[]): string | undefined {
  if (entries.includes('main')) return 'main';
  return (
    entries.find((n) => /^(display|show|init|setup|pre_?auton|start)/i.test(n)) ??
    entries.find((n) => /selector|screen|draw|auton/i.test(n)) ??
    entries[0]
  );
}

export function compile(source: string, lang: Lang, globalNames: string[], entry?: string): CompiledProgram {
  const js = toJs(source, lang, globalNames, entry);
  try {
    return new Function('$', '$g', js) as CompiledProgram;
  } catch (e) {
    throw new SyntaxErr(`The simulator could not translate this code (${(e as Error).message}). Please report it with the code that caused this.`, 0);
  }
}
