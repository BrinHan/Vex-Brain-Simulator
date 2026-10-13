import { SyntaxErr } from './ast';

export interface Tok {
  t: 'id' | 'num' | 'str' | 'char' | 'op' | 'eof';
  v: string;
  line: number;
  int?: boolean; // numeric literal without fraction/exponent
  num?: number;
}

const OPS3 = ['<<=', '>>=', '...', '->*'];
const OPS2 = ['::', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];

function unescape(src: string, i: number, line: number): [string, number] {
  // src[i] is the char after the backslash
  const c = src[i];
  switch (c) {
    case 'n': return ['\n', i + 1];
    case 't': return ['\t', i + 1];
    case 'r': return ['\r', i + 1];
    case '0': return ['\0', i + 1];
    case 'a': return ['\x07', i + 1];
    case 'b': return ['\b', i + 1];
    case 'f': return ['\f', i + 1];
    case 'v': return ['\v', i + 1];
    case '\\': return ['\\', i + 1];
    case "'": return ["'", i + 1];
    case '"': return ['"', i + 1];
    case '?': return ['?', i + 1];
    case 'x': {
      let j = i + 1;
      let h = '';
      while (j < src.length && /[0-9a-fA-F]/.test(src[j])) h += src[j++];
      return [String.fromCharCode(parseInt(h || '0', 16)), j];
    }
    default:
      if (c === undefined) throw new SyntaxErr('Unterminated escape sequence', line);
      return [c, i + 1];
  }
}

interface Macro { params: string[] | null; body: Tok[] }

/** Expands #define macros (object-like and function-like) over a token list. */
function expandMacros(toks: Tok[], macros: Map<string, Macro>, disabled: Set<string>): Tok[] {
  if (!macros.size) return toks;
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const m = t.t === 'id' && !disabled.has(t.v) ? macros.get(t.v) : undefined;
    if (!m) { out.push(t); continue; }
    const off = new Set([...disabled, t.v]);
    if (m.params === null) {
      out.push(...expandMacros(m.body.map((b) => ({ ...b, line: t.line })), macros, off));
      continue;
    }
    const nx = toks[i + 1];
    if (!(nx && nx.t === 'op' && nx.v === '(')) { out.push(t); continue; }
    let j = i + 2;
    let depth = 1;
    const args: Tok[][] = [[]];
    while (j < toks.length) {
      const x = toks[j];
      if (x.t === 'op' && x.v === '(') depth++;
      if (x.t === 'op' && x.v === ')') { depth--; if (depth === 0) break; }
      if (x.t === 'op' && x.v === ',' && depth === 1) args.push([]);
      else args[args.length - 1].push(x);
      j++;
    }
    const body: Tok[] = [];
    for (const b of m.body) {
      const pi = b.t === 'id' ? m.params.indexOf(b.v) : -1;
      if (pi >= 0) body.push(...(args[pi] ?? []));
      else body.push({ ...b, line: t.line });
    }
    out.push(...expandMacros(body, macros, off));
    i = j;
  }
  return out;
}

export function lexCpp(src: string): Tok[] {
  const macros = new Map<string, Macro>();
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = true;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; lineStart = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === '#' && lineStart) {
      // preprocessor line (with backslash continuation): #define is recorded, everything else ignored
      let text = '';
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\' && src[i + 1] === '\n') { line++; i += 2; text += ' '; continue; }
        text += src[i++];
      }
      const dm = /^#\s*define\s+([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/.exec(text.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '').trim());
      if (dm) {
        macros.set(dm[1], {
          params: dm[2] !== undefined ? dm[3].split(',').map((p) => p.trim()).filter(Boolean) : null,
          body: lexCpp(dm[4]).filter((t) => t.t !== 'eof'),
        });
      }
      continue;
    }
    lineStart = false;
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isInt = true;
      let value: number;
      if (c === '0' && /[xX]/.test(src[i + 1] ?? '')) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F']/.test(src[j])) j++;
        value = parseInt(src.slice(i + 2, j).replace(/'/g, ''), 16);
      } else if (c === '0' && /[bB]/.test(src[i + 1] ?? '')) {
        j = i + 2;
        while (j < n && /[01']/.test(src[j])) j++;
        value = parseInt(src.slice(i + 2, j).replace(/'/g, ''), 2);
      } else {
        while (j < n && /[0-9']/.test(src[j])) j++;
        if (src[j] === '.') { isInt = false; j++; while (j < n && /[0-9]/.test(src[j])) j++; }
        if (/[eE]/.test(src[j] ?? '') && /[0-9+-]/.test(src[j + 1] ?? '')) {
          isInt = false;
          j += 2;
          while (j < n && /[0-9]/.test(src[j])) j++;
        }
        value = parseFloat(src.slice(i, j).replace(/'/g, ''));
        if (isInt && c === '0' && j - i > 1 && /^[0-7]+$/.test(src.slice(i, j))) value = parseInt(src.slice(i, j), 8);
      }
      // suffixes
      while (j < n && /[uUlLfF]/.test(src[j])) {
        if (/[fF]/.test(src[j]) && !(c === '0' && /[xX]/.test(src[i + 1] ?? ''))) isInt = false;
        j++;
      }
      toks.push({ t: 'num', v: src.slice(i, j), line, int: isInt, num: value });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\n') throw new SyntaxErr('Unterminated string literal', line);
        if (src[j] === '\\') { const [ch, nj] = unescape(src, j + 1, line); s += ch; j = nj; } else s += src[j++];
      }
      if (j >= n) throw new SyntaxErr('Unterminated string literal', line);
      const prev = toks[toks.length - 1];
      if (prev && prev.t === 'str') prev.v += s; // adjacent literal concatenation
      else toks.push({ t: 'str', v: s, line });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\') { const [ch, nj] = unescape(src, j + 1, line); s += ch; j = nj; } else s += src[j++];
      }
      toks.push({ t: 'char', v: s, line });
      i = j + 1;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) { toks.push({ t: 'op', v: three, line }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { toks.push({ t: 'op', v: two, line }); i += 2; continue; }
    toks.push({ t: 'op', v: c, line });
    i++;
  }
  toks.push({ t: 'eof', v: '', line });
  return expandMacros(toks, macros, new Set());
}
