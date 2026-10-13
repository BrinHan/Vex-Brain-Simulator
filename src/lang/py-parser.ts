import { Expr, FuncDecl, Param, Program, Stmt, StructDecl, SyntaxErr } from './ast';

// ------------------------------------------------------------------ lexer
interface PTok {
  t: 'id' | 'num' | 'str' | 'fstr' | 'op' | 'nl' | 'indent' | 'dedent' | 'eof';
  v: string;
  line: number;
  int?: boolean;
  num?: number;
  raw?: boolean;
}

const OPS3 = ['**=', '//=', '>>=', '<<=', '...'];
const OPS2 = ['**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->', ':='];

function pyEscape(s: string, i: number): [string, number] {
  const c = s[i];
  switch (c) {
    case 'n': return ['\n', i + 1];
    case 't': return ['\t', i + 1];
    case 'r': return ['\r', i + 1];
    case '0': return ['\0', i + 1];
    case '\\': return ['\\', i + 1];
    case "'": return ["'", i + 1];
    case '"': return ['"', i + 1];
    case '\n': return ['', i + 1];
    case 'x': return [String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)), i + 3];
    case 'u': return [String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)), i + 5];
    default: return ['\\' + (c ?? ''), i + 1];
  }
}

function lexPy(src: string): PTok[] {
  const toks: PTok[] = [];
  const indents = [0];
  let i = 0;
  let line = 1;
  let depth = 0;
  let atLineStart = true;
  const n = src.length;
  while (i < n) {
    if (atLineStart && depth === 0) {
      // measure indentation
      let col = 0;
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) { col += src[j] === '\t' ? 8 - (col % 8) : 1; j++; }
      if (j >= n) { i = j; break; }
      if (src[j] === '\n' || src[j] === '\r' || src[j] === '#') {
        while (j < n && src[j] !== '\n') j++;
        i = j + 1;
        line++;
        continue;
      }
      i = j;
      if (col > indents[indents.length - 1]) { indents.push(col); toks.push({ t: 'indent', v: '', line }); }
      else {
        while (col < indents[indents.length - 1]) { indents.pop(); toks.push({ t: 'dedent', v: '', line }); }
        if (col !== indents[indents.length - 1]) throw new SyntaxErr('Unindent does not match any outer indentation level', line);
      }
      atLineStart = false;
    }
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      if (depth === 0) {
        if (toks.length && toks[toks.length - 1].t !== 'nl') toks.push({ t: 'nl', v: '', line: line - 1 });
        atLineStart = true;
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '\\' && src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; line++; continue; }
    // strings (with prefixes)
    const sm = /^([rRbBfFuU]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
    if (sm && (sm[1] === '' || /^[rRbBfFuU]+$/.test(sm[1]))) {
      const prefix = sm[1].toLowerCase();
      const quote = sm[2];
      const raw = prefix.includes('r');
      const isF = prefix.includes('f');
      let j = i + sm[0].length;
      let s = '';
      let closed = false;
      while (j < n) {
        if (src.startsWith(quote, j)) { closed = true; j += quote.length; break; }
        if (src[j] === '\n') {
          if (quote.length === 1) throw new SyntaxErr('Unterminated string literal', line);
          line++;
        }
        if (src[j] === '\\' && !(isF && false)) {
          if (raw || isF) { s += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
          const [ch, nj] = pyEscape(src, j + 1);
          s += ch;
          j = nj;
          continue;
        }
        s += src[j++];
      }
      if (!closed) throw new SyntaxErr('Unterminated string literal', line);
      if (isF) toks.push({ t: 'fstr', v: s, line, raw });
      else toks.push({ t: 'str', v: s, line });
      i = j;
      continue;
    }
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
        while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
        value = parseInt(src.slice(i + 2, j).replace(/_/g, ''), 16);
      } else if (c === '0' && /[bB]/.test(src[i + 1] ?? '')) {
        j = i + 2;
        while (j < n && /[01_]/.test(src[j])) j++;
        value = parseInt(src.slice(i + 2, j).replace(/_/g, ''), 2);
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === '.') { isInt = false; j++; while (j < n && /[0-9_]/.test(src[j])) j++; }
        if (/[eE]/.test(src[j] ?? '') && /[0-9+-]/.test(src[j + 1] ?? '')) {
          isInt = false;
          j += 2;
          while (j < n && /[0-9]/.test(src[j])) j++;
        }
        value = parseFloat(src.slice(i, j).replace(/_/g, ''));
      }
      toks.push({ t: 'num', v: src.slice(i, j), line, int: isInt, num: value });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    let op = c;
    if (OPS3.includes(three)) op = three;
    else if (OPS2.includes(two)) op = two;
    if ('([{'.includes(op)) depth++;
    else if (')]}'.includes(op)) depth = Math.max(0, depth - 1);
    toks.push({ t: 'op', v: op, line });
    i += op.length;
  }
  if (toks.length && toks[toks.length - 1].t !== 'nl') toks.push({ t: 'nl', v: '', line });
  while (indents.length > 1) { indents.pop(); toks.push({ t: 'dedent', v: '', line }); }
  toks.push({ t: 'eof', v: '', line });
  return toks;
}

// ------------------------------------------------------------------ parser
const AUG = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=']);
const CMP = new Set(['<', '>', '==', '!=', '<=', '>=']);

class PyParser {
  toks: PTok[];
  pos = 0;
  constructor(src: string) { this.toks = lexPy(src); }

  get cur(): PTok { return this.toks[this.pos]; }
  at(o: number): PTok { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  isOp(v: string, o = 0): boolean { const t = this.at(o); return t.t === 'op' && t.v === v; }
  isKw(v: string, o = 0): boolean { const t = this.at(o); return t.t === 'id' && t.v === v; }
  accept(v: string): boolean { if (this.isOp(v)) { this.pos++; return true; } return false; }
  acceptKw(v: string): boolean { if (this.isKw(v)) { this.pos++; return true; } return false; }
  err(msg: string): never { throw new SyntaxErr(msg, this.cur.line); }
  describe(): string {
    const t = this.cur;
    if (t.t === 'nl') return 'end of line';
    if (t.t === 'eof') return 'end of file';
    if (t.t === 'indent') return 'unexpected indent';
    if (t.t === 'dedent') return 'unindent';
    return `'${t.v}'`;
  }
  expect(v: string): void { if (!this.accept(v)) this.err(`Expected '${v}' but found ${this.describe()}`); }
  expectKw(v: string): void { if (!this.acceptKw(v)) this.err(`Expected '${v}' but found ${this.describe()}`); }
  ident(): string {
    if (this.cur.t !== 'id') this.err(`Expected a name but found ${this.describe()}`);
    return this.toks[this.pos++].v;
  }

  parseProgram(): Program {
    const body: Stmt[] = [];
    while (this.cur.t !== 'eof') {
      if (this.cur.t === 'nl') { this.pos++; continue; }
      if (this.cur.t === 'indent') this.err('Unexpected indent');
      body.push(...this.parseStatement());
    }
    return { lang: 'py', body };
  }

  endSimple(): void {
    const t = this.cur.t as string;
    if (t === 'nl') this.pos++;
    else if (t !== 'eof' && t !== 'dedent') this.err(`Unexpected ${this.describe()}`);
  }

  parseBlock(): Stmt[] {
    this.expect(':');
    if (this.cur.t === 'nl') {
      this.pos++;
      if ((this.cur.t as string) !== 'indent') this.err('Expected an indented block');
      this.pos++;
      const body: Stmt[] = [];
      while ((this.cur.t as string) !== 'dedent' && (this.cur.t as string) !== 'eof') {
        if ((this.cur.t as string) === 'nl') { this.pos++; continue; }
        body.push(...this.parseStatement());
      }
      if ((this.cur.t as string) === 'dedent') this.pos++;
      return body;
    }
    return this.parseSimpleLine();
  }

  parseStatement(): Stmt[] {
    const t = this.cur;
    if (t.t === 'op' && t.v === '@') { while (this.cur.t !== 'nl' && this.cur.t !== 'eof') this.pos++; return []; }
    if (t.t === 'id') {
      switch (t.v) {
        case 'if': return [this.parseIf()];
        case 'while': {
          this.pos++;
          const test = this.parseTest();
          const body = this.parseBlock();
          if (this.isKw('else')) { this.pos++; this.parseBlock(); }
          return [{ k: 'while', test, body }];
        }
        case 'for': return [this.parseFor()];
        case 'def': return [this.parseDef()];
        case 'class': return [this.parseClass()];
        case 'try': return [this.parseTry()];
        case 'with': {
          this.pos++;
          const out: Stmt[] = [];
          const ctx = this.parseTest();
          if (this.acceptKw('as')) {
            const name = this.ident();
            out.push({ k: 'expr', e: { k: 'assign', op: '=', target: { k: 'id', name }, value: ctx } });
          }
          out.push({ k: 'block', body: this.parseBlock() });
          return out;
        }
      }
    }
    return this.parseSimpleLine();
  }

  parseSimpleLine(): Stmt[] {
    const out: Stmt[] = [this.parseSimple()];
    while (this.accept(';')) {
      if (this.cur.t === 'nl' || this.cur.t === 'eof') break;
      out.push(this.parseSimple());
    }
    this.endSimple();
    return out;
  }

  parseSimple(): Stmt {
    const t = this.cur;
    if (t.t === 'id') {
      switch (t.v) {
        case 'pass': this.pos++; return { k: 'pass' };
        case 'break': this.pos++; return { k: 'break' };
        case 'continue': this.pos++; return { k: 'continue' };
        case 'return': {
          this.pos++;
          const e = this.atEndOfSimple() ? undefined : this.parseExprList();
          return { k: 'return', e };
        }
        case 'global':
        case 'nonlocal': {
          this.pos++;
          const names = [this.ident()];
          while (this.accept(',')) names.push(this.ident());
          return { k: 'global', names };
        }
        case 'from': {
          // `from math import sqrt` -> sqrt = math.sqrt ; `from vex import *` is a no-op
          this.pos++;
          const mod = this.ident();
          while (this.accept('.')) this.ident();
          const assigns: Stmt[] = [];
          if (this.acceptKw('import')) {
            this.accept('(');
            while (this.cur.t === 'id' || this.isOp('*')) {
              if (this.accept('*')) break;
              const name = this.ident();
              const alias = this.acceptKw('as') ? this.ident() : name;
              if (mod !== 'vex') assigns.push({ k: 'expr', e: { k: 'assign', op: '=', target: { k: 'id', name: alias }, value: { k: 'member', obj: { k: 'id', name: mod }, prop: name } } });
              if (!this.accept(',')) break;
            }
          }
          while (this.cur.t !== 'nl' && this.cur.t !== 'eof' && !this.isOp(';')) this.pos++;
          return assigns.length ? { k: 'multi', decls: assigns } : { k: 'pass' };
        }
        case 'import':
          while (this.cur.t !== 'nl' && this.cur.t !== 'eof' && !this.isOp(';')) this.pos++;
          return { k: 'pass' };
        case 'del':
        case 'assert':
          while (this.cur.t !== 'nl' && this.cur.t !== 'eof' && !this.isOp(';')) this.pos++;
          return { k: 'pass' };
        case 'raise': {
          this.pos++;
          const e = this.atEndOfSimple() ? undefined : this.parseTest();
          return { k: 'throw', e };
        }
      }
    }
    const first = this.parseExprList();
    if (this.isOp(':') && (first.k === 'id' || first.k === 'member')) {
      // annotated assignment: x: int = 5
      this.pos++;
      this.parseTest();
      if (this.accept('=')) return { k: 'expr', e: { k: 'assign', op: '=', target: first, value: this.parseExprList() } };
      return { k: 'pass' };
    }
    if (this.isOp('=')) {
      const targets: Expr[] = [first];
      let value: Expr;
      for (;;) {
        this.pos++;
        value = this.parseExprList();
        if (this.isOp('=')) targets.push(value);
        else break;
      }
      let e: Expr = value;
      for (let i = targets.length - 1; i >= 0; i--) e = { k: 'assign', op: '=', target: targets[i], value: e };
      return { k: 'expr', e };
    }
    if (this.cur.t === 'op' && AUG.has(this.cur.v)) {
      const op = this.cur.v;
      this.pos++;
      return { k: 'expr', e: { k: 'assign', op, target: first, value: this.parseExprList() } };
    }
    return { k: 'expr', e: first };
  }

  atEndOfSimple(): boolean {
    return this.cur.t === 'nl' || this.cur.t === 'eof' || this.isOp(';') || this.cur.t === 'dedent';
  }

  parseIf(): Stmt {
    this.pos++; // if / elif
    const test = this.parseTest();
    const then = this.parseBlock();
    let els: Stmt[] | undefined;
    if (this.isKw('elif')) els = [this.parseIf()];
    else if (this.isKw('else')) { this.pos++; els = this.parseBlock(); }
    return { k: 'if', test, then, else: els };
  }

  parseTargetNames(): string[] {
    const names: string[] = [];
    const paren = this.accept('(');
    names.push(this.ident());
    while (this.accept(',')) { if (this.isKw('in')) break; names.push(this.ident()); }
    if (paren) this.expect(')');
    return names;
  }

  parseFor(): Stmt {
    this.pos++;
    const vars = this.parseTargetNames();
    this.expectKw('in');
    const iter = this.parseExprList();
    const body = this.parseBlock();
    if (this.isKw('else')) { this.pos++; this.parseBlock(); }
    return { k: 'forin', vars, iter, body };
  }

  parseParams(close: string): Param[] {
    const params: Param[] = [];
    while (!this.isOp(close)) {
      if (this.accept('/')) { if (!this.accept(',')) break; continue; }
      if (this.accept('**')) { params.push({ name: this.ident(), star: 'kwargs' }); }
      else if (this.accept('*')) {
        if (this.cur.t === 'id') params.push({ name: this.ident(), star: 'args' });
      } else {
        const p: Param = { name: this.ident() };
        if (close === ')' && this.accept(':')) this.parseTest();
        if (this.accept('=')) p.def = this.parseTest();
        params.push(p);
      }
      if (!this.accept(',')) break;
    }
    return params;
  }

  parseDef(): FuncDecl {
    this.pos++;
    const name = this.ident();
    this.expect('(');
    const params = this.parseParams(')');
    this.expect(')');
    if (this.accept('->')) this.parseTest();
    const body = this.parseBlock();
    return { k: 'func', name, params, body };
  }

  parseClass(): StructDecl {
    this.pos++;
    const name = this.ident();
    let base: string | undefined;
    if (this.accept('(')) {
      if (this.cur.t === 'id') base = this.ident();
      while (!this.isOp(')') && this.cur.t !== 'eof') this.pos++;
      this.expect(')');
    }
    const body = this.parseBlock();
    const decl: StructDecl = { k: 'struct', name, base, fields: [], methods: [], ctors: [] };
    for (const s of body) {
      if (s.k === 'func') decl.methods.push(s);
      else if (s.k === 'expr' && s.e.k === 'assign' && s.e.target.k === 'id') decl.fields.push({ name: s.e.target.name, init: s.e.value });
    }
    return decl;
  }

  parseTry(): Stmt {
    this.pos++;
    const body = this.parseBlock();
    let catchVar: string | undefined;
    let handler: Stmt[] | undefined;
    let fin: Stmt[] | undefined;
    while (this.isKw('except')) {
      this.pos++;
      let v: string | undefined;
      if (!this.isOp(':')) {
        this.parseTest();
        if (this.acceptKw('as')) v = this.ident();
      }
      const h = this.parseBlock();
      if (!handler) { handler = h; catchVar = v; }
    }
    if (this.isKw('else')) { this.pos++; this.parseBlock(); }
    if (this.isKw('finally')) { this.pos++; fin = this.parseBlock(); }
    return { k: 'try', body, catchVar, handler, fin };
  }

  // ---- expressions ----
  parseExprList(): Expr {
    const first = this.parseTest();
    if (!this.isOp(',')) return first;
    const items = [first];
    while (this.accept(',')) {
      if (this.atEndOfSimple() || this.isOp('=') || this.isOp(')') || this.isOp(']') || this.isOp(':')) break;
      items.push(this.parseTest());
    }
    return { k: 'list', items, tuple: true };
  }

  parseTest(): Expr {
    if (this.isKw('lambda')) return this.parseLambda();
    const e = this.parseOr();
    if (this.isKw('if')) {
      this.pos++;
      const test = this.parseOr();
      this.expectKw('else');
      const b = this.parseTest();
      return { k: 'cond', test, a: e, b };
    }
    return e;
  }

  parseLambda(): Expr {
    this.pos++;
    const params = this.parseParams(':');
    this.expect(':');
    return { k: 'lambda', params, body: this.parseTest() };
  }

  parseOr(): Expr {
    let l = this.parseAnd();
    while (this.acceptKw('or')) l = { k: 'bin', op: '||', l, r: this.parseAnd() };
    return l;
  }
  parseAnd(): Expr {
    let l = this.parseNot();
    while (this.acceptKw('and')) l = { k: 'bin', op: '&&', l, r: this.parseNot() };
    return l;
  }
  parseNot(): Expr {
    if (this.acceptKw('not')) return { k: 'unary', op: '!', arg: this.parseNot() };
    return this.parseCompare();
  }

  parseCompare(): Expr {
    const first = this.parseBitOr();
    let prev = first;
    let result: Expr | undefined;
    for (;;) {
      let op: string | undefined;
      const t = this.cur;
      if (t.t === 'op' && CMP.has(t.v)) { op = t.v; this.pos++; }
      else if (this.isKw('in')) { op = 'in'; this.pos++; }
      else if (this.isKw('not') && this.isKw('in', 1)) { op = 'not in'; this.pos += 2; }
      else if (this.isKw('is')) { this.pos++; op = this.acceptKw('not') ? 'is not' : 'is'; }
      if (!op) break;
      const right = this.parseBitOr();
      const cmp: Expr = { k: 'bin', op, l: prev, r: right };
      result = result ? { k: 'bin', op: '&&', l: result, r: cmp } : cmp;
      prev = right;
    }
    return result ?? first;
  }

  binLevel(next: () => Expr, ops: string[]): Expr {
    let l = next();
    while (this.cur.t === 'op' && ops.includes(this.cur.v)) {
      const op = this.cur.v;
      this.pos++;
      l = { k: 'bin', op, l, r: next() };
    }
    return l;
  }
  parseBitOr(): Expr { return this.binLevel(() => this.parseBitXor(), ['|']); }
  parseBitXor(): Expr { return this.binLevel(() => this.parseBitAnd(), ['^']); }
  parseBitAnd(): Expr { return this.binLevel(() => this.parseShift(), ['&']); }
  parseShift(): Expr { return this.binLevel(() => this.parseArith(), ['<<', '>>']); }
  parseArith(): Expr { return this.binLevel(() => this.parseTerm(), ['+', '-']); }
  parseTerm(): Expr { return this.binLevel(() => this.parseFactor(), ['*', '/', '//', '%']); }

  parseFactor(): Expr {
    if (this.cur.t === 'op' && (this.cur.v === '-' || this.cur.v === '+' || this.cur.v === '~')) {
      const op = this.cur.v;
      this.pos++;
      return { k: 'unary', op, arg: this.parseFactor() };
    }
    const base = this.parsePostfix();
    if (this.accept('**')) return { k: 'bin', op: '**', l: base, r: this.parseFactor() };
    return base;
  }

  parsePostfix(): Expr {
    let e = this.parseAtom();
    for (;;) {
      if (this.isOp('(')) {
        this.pos++;
        const args: Expr[] = [];
        const kwargs: { name: string; value: Expr }[] = [];
        while (!this.isOp(')')) {
          if (this.cur.t === 'id' && this.isOp('=', 1)) {
            const name = this.ident();
            this.pos++;
            kwargs.push({ name, value: this.parseTest() });
          } else {
            const a = this.parseTest();
            if (this.isKw('for')) args.push(this.parseCompTail(a));
            else args.push(a);
          }
          if (!this.accept(',')) break;
        }
        this.expect(')');
        e = { k: 'call', callee: e, args, ...(kwargs.length ? { kwargs } : {}) };
      } else if (this.isOp('[')) {
        this.pos++;
        e = this.parseSubscript(e);
        this.expect(']');
      } else if (this.isOp('.')) {
        this.pos++;
        e = { k: 'member', obj: e, prop: this.ident() };
      } else break;
    }
    return e;
  }

  parseSubscript(obj: Expr): Expr {
    let lo: Expr | undefined;
    if (!this.isOp(':')) {
      lo = this.parseTest();
      if (!this.isOp(':')) return { k: 'index', obj, idx: lo };
    }
    this.expect(':');
    let hi: Expr | undefined;
    let step: Expr | undefined;
    if (!this.isOp(']') && !this.isOp(':')) hi = this.parseTest();
    if (this.accept(':') && !this.isOp(']')) step = this.parseTest();
    return { k: 'slice', obj, lo, hi, step };
  }

  parseCompTail(elt: Expr): Expr {
    this.expectKw('for');
    const vars = this.parseTargetNames();
    this.expectKw('in');
    const iter = this.parseOr();
    let cond: Expr | undefined;
    if (this.acceptKw('if')) cond = this.parseOr();
    if (this.isKw('for')) this.err('Nested comprehensions are not supported by the simulator');
    return { k: 'listcomp', elt, vars, iter, cond };
  }

  parseAtom(): Expr {
    const t = this.cur;
    switch (t.t) {
      case 'num': this.pos++; return { k: 'num', v: t.num as number, int: !!t.int };
      case 'str': {
        this.pos++;
        let s = t.v;
        while (this.cur.t === 'str') s += this.toks[this.pos++].v;
        return { k: 'str', v: s };
      }
      case 'fstr': this.pos++; return this.parseFString(t);
      case 'id':
        if (t.v === 'True' || t.v === 'False') { this.pos++; return { k: 'bool', v: t.v === 'True' }; }
        if (t.v === 'None') { this.pos++; return { k: 'null' }; }
        this.pos++;
        return { k: 'id', name: t.v };
      case 'op':
        if (t.v === '(') {
          this.pos++;
          if (this.accept(')')) return { k: 'list', items: [], tuple: true };
          const first = this.parseTest();
          if (this.isKw('for')) { const c = this.parseCompTail(first); this.expect(')'); return c; }
          if (this.isOp(',')) {
            const items = [first];
            while (this.accept(',')) { if (this.isOp(')')) break; items.push(this.parseTest()); }
            this.expect(')');
            return { k: 'list', items, tuple: true };
          }
          this.expect(')');
          return first;
        }
        if (t.v === '[') {
          this.pos++;
          if (this.accept(']')) return { k: 'list', items: [] };
          const first = this.parseTest();
          if (this.isKw('for')) { const c = this.parseCompTail(first); this.expect(']'); return c; }
          const items = [first];
          while (this.accept(',')) { if (this.isOp(']')) break; items.push(this.parseTest()); }
          this.expect(']');
          return { k: 'list', items };
        }
        if (t.v === '{') {
          this.pos++;
          const entries: [Expr, Expr][] = [];
          const setItems: Expr[] = [];
          let isSet = false;
          while (!this.isOp('}')) {
            const k = this.parseTest();
            if (this.accept(':')) entries.push([k, this.parseTest()]);
            else { isSet = true; setItems.push(k); }
            if (!this.accept(',')) break;
          }
          this.expect('}');
          return isSet ? { k: 'list', items: setItems } : { k: 'dict', entries };
        }
        break;
    }
    this.err(`Invalid syntax: unexpected ${this.describe()}`);
  }

  parseFString(t: PTok): Expr {
    const s = t.v;
    const parts: (string | { e: Expr; spec?: string; conv?: string })[] = [];
    let lit = '';
    const flush = (): void => { if (lit) { parts.push(lit); lit = ''; } };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '{' && s[i + 1] === '{') { lit += '{'; i += 2; continue; }
      if (c === '}' && s[i + 1] === '}') { lit += '}'; i += 2; continue; }
      if (c === '\\' && !t.raw) { const [ch, ni] = pyEscape(s, i + 1); lit += ch; i = ni; continue; }
      if (c !== '{') { lit += c; i++; continue; }
      // expression field
      let j = i + 1;
      let depth = 0;
      let quote = '';
      let specAt = -1;
      let convAt = -1;
      for (; j < s.length; j++) {
        const d = s[j];
        if (quote) { if (d === quote) quote = ''; continue; }
        if (d === '"' || d === "'") { quote = d; continue; }
        if ('([{'.includes(d)) depth++;
        else if (')]'.includes(d)) depth--;
        else if (d === '}') { if (depth === 0) break; depth--; }
        else if (depth === 0 && d === '!' && s[j + 1] !== '=' && convAt < 0 && specAt < 0) convAt = j;
        else if (depth === 0 && d === ':' && specAt < 0) specAt = j;
      }
      if (j >= s.length) throw new SyntaxErr("f-string: expecting '}'", t.line);
      const exprEnd = convAt >= 0 ? convAt : specAt >= 0 ? specAt : j;
      const exprSrc = s.slice(i + 1, exprEnd).trim();
      const sub = new PyParser(exprSrc);
      const e = sub.parseTest();
      const conv = convAt >= 0 ? s.slice(convAt + 1, specAt >= 0 ? specAt : j) : undefined;
      const spec = specAt >= 0 ? s.slice(specAt + 1, j) : undefined;
      flush();
      parts.push({ e, spec, conv });
      i = j + 1;
    }
    flush();
    return { k: 'fstr', parts };
  }
}

export function parsePython(src: string): Program {
  return new PyParser(src).parseProgram();
}
