import { Expr, FieldDecl, FuncDecl, Param, Program, Stmt, StructDecl, SyntaxErr, TypeRef } from './ast';
import { lexCpp, Tok } from './cpp-lexer';

const PRIM = new Set([
  'int', 'long', 'short', 'unsigned', 'signed', 'char', 'bool', 'float', 'double', 'void', 'auto', 'size_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'string', 'wchar_t',
]);
const QUALS = new Set(['const', 'static', 'volatile', 'constexpr', 'inline', 'extern', 'register', 'mutable', 'virtual', 'explicit', 'friend', 'typename']);
const TEMPLATES = new Set(['vector', 'array', 'map', 'unordered_map', 'pair', 'set', 'list', 'deque', 'function', 'unique_ptr', 'shared_ptr', 'tuple', 'queue', 'stack', 'optional']);
const NONTYPE = new Set([
  'return', 'else', 'new', 'delete', 'throw', 'goto', 'case', 'default', 'sizeof', 'if', 'while', 'for', 'do', 'switch',
  'break', 'continue', 'true', 'false', 'nullptr', 'this', 'using', 'typedef', 'namespace', 'public', 'private', 'protected',
]);
const DROP_NS = new Set(['std', 'vex']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};
const CAST_KW = new Set(['static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast']);
export const OPERATOR_NAMES: Record<string, string> = {
  '==': 'eq', '!=': 'ne', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge', '+': 'add', '-': 'sub', '*': 'mul', '/': 'div',
};

class CppParser {
  toks: Tok[];
  pos = 0;
  knownTypes = new Set<string>();
  aliases = new Map<string, TypeRef>();
  hoisted: Stmt[] = [];

  constructor(src: string) {
    this.toks = lexCpp(src);
    for (let i = 0; i < this.toks.length - 1; i++) {
      const t = this.toks[i];
      if (t.t === 'id' && (t.v === 'struct' || t.v === 'class' || t.v === 'enum')) {
        let j = i + 1;
        if (this.toks[j].t === 'id' && (this.toks[j].v === 'class' || this.toks[j].v === 'struct')) j++;
        if (this.toks[j].t === 'id') this.knownTypes.add(this.toks[j].v);
      }
    }
  }

  // ---- token helpers ----
  get cur(): Tok { return this.toks[this.pos]; }
  at(o: number): Tok { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  isOp(v: string, o = 0): boolean { const t = this.at(o); return t.t === 'op' && t.v === v; }
  isId(v: string, o = 0): boolean { const t = this.at(o); return t.t === 'id' && t.v === v; }
  accept(v: string): boolean { if (this.isOp(v)) { this.pos++; return true; } return false; }
  err(msg: string): never { throw new SyntaxErr(msg, this.cur.line); }
  expect(v: string): void {
    if (!this.accept(v)) this.err(`Expected '${v}' but found '${this.cur.v || 'end of file'}'`);
  }
  ident(): string {
    if (this.cur.t !== 'id') this.err(`Expected a name but found '${this.cur.v || 'end of file'}'`);
    return this.toks[this.pos++].v;
  }
  skipBalanced(open: string, close: string): void {
    let depth = 0;
    do {
      if (this.cur.t === 'eof') this.err(`Missing closing '${close}'`);
      if (this.isOp(open)) depth++;
      else if (this.isOp(close)) depth--;
      this.pos++;
    } while (depth > 0);
  }

  // ---- program ----
  parseProgram(): Program {
    const body: Stmt[] = [];
    while (this.cur.t !== 'eof') {
      this.parseTopLevel(body);
    }
    return { lang: 'cpp', body: [...this.hoisted, ...body] };
  }

  parseTopLevel(out: Stmt[]): void {
    if (this.accept(';')) return;
    if (this.isId('using')) { this.parseUsing(); return; }
    if (this.isId('typedef')) { this.parseTypedef(); return; }
    if (this.isId('namespace')) {
      this.pos++;
      if (this.cur.t === 'id') this.pos++;
      this.expect('{');
      while (!this.isOp('}') && this.cur.t !== 'eof') this.parseTopLevel(out);
      this.expect('}');
      return;
    }
    if (this.isId('template')) this.err('C++ templates are not supported by the simulator');
    if ((this.isId('struct') || this.isId('class')) && this.at(1).t === 'id' && (this.isOp('{', 2) || this.isOp(':', 2))) {
      this.pos++;
      this.hoisted.push(this.parseStruct());
      return;
    }
    if ((this.isId('struct') || this.isId('class')) && this.at(1).t === 'id' && this.isOp(';', 2)) { this.pos += 3; return; }
    if (this.isId('enum')) { this.hoisted.push(this.parseEnum()); return; }
    this.parseDeclOrFunc(out, true);
  }

  parseUsing(): void {
    this.pos++; // using
    if (this.isId('namespace')) {
      while (!this.isOp(';') && this.cur.t !== 'eof') this.pos++;
      this.expect(';');
      return;
    }
    const name = this.ident();
    if (this.accept('=')) {
      const t = this.tryType();
      if (t) { this.aliases.set(name, t); this.knownTypes.add(name); }
    }
    while (!this.isOp(';') && this.cur.t !== 'eof') this.pos++;
    this.expect(';');
  }

  parseTypedef(): void {
    this.pos++;
    const t = this.tryType();
    if (t && this.cur.t === 'id') {
      const name = this.ident();
      this.aliases.set(name, t);
      this.knownTypes.add(name);
    }
    while (!this.isOp(';') && this.cur.t !== 'eof') this.pos++;
    this.expect(';');
  }

  // ---- types ----
  isTypeStart(): boolean {
    return this.cur.t === 'id' && !NONTYPE.has(this.cur.v);
  }

  /** Try to parse a type; on failure restore position and return null. */
  tryType(): TypeRef | null {
    const save = this.pos;
    const t = this.parseTypeInner();
    if (!t) this.pos = save;
    return t;
  }

  parseTypeInner(): TypeRef | null {
    let unsigned = false;
    let sawMod = false;
    let isLong = false;
    let isStatic = false;
    for (;;) {
      const t = this.cur;
      if (t.t !== 'id') break;
      if (t.v === 'static') isStatic = true;
      if (QUALS.has(t.v) || t.v === 'struct' || t.v === 'class' || t.v === 'enum') { this.pos++; continue; }
      if (t.v === 'unsigned' || t.v === 'signed') { if (t.v === 'unsigned') unsigned = true; sawMod = true; this.pos++; continue; }
      if (t.v === 'long' || t.v === 'short') { if (t.v === 'long') isLong = true; sawMod = true; this.pos++; continue; }
      break;
    }
    let name: string | undefined;
    let args: TypeRef[] | undefined;
    if (this.isTypeStart()) {
      const segs: string[] = [this.cur.v];
      this.pos++;
      while (this.isOp('::') && this.at(1).t === 'id') { this.pos++; segs.push(this.cur.v); this.pos++; }
      while (segs.length > 1 && DROP_NS.has(segs[0])) segs.shift();
      name = segs[segs.length - 1];
      if (this.isOp('<') && (TEMPLATES.has(name) || segs.length > 1)) {
        const a = this.parseTemplateArgs(name);
        if (a === null) return null;
        args = a;
      }
    }
    if (!name) {
      if (!sawMod) return null;
      name = 'int';
    } else if (sawMod) {
      if (name === 'double' || name === 'float') name = 'double';
      else if (name === 'char') name = unsigned ? 'int' : 'char';
      else if (name !== 'int') {
        // "unsigned foo" - the identifier was actually a variable name; treat modifier-only as int
        this.pos--;
        name = 'int';
      }
    }
    if (isLong && name === 'int') name = 'int';
    const alias = this.aliases.get(name);
    const result: TypeRef = alias ? { ...alias } : { name, ...(args ? { args } : {}) };
    if (isStatic) result.isStatic = true;
    for (;;) {
      if (this.isId('const')) { this.pos++; continue; }
      if (this.accept('*')) { result.ptr = true; continue; }
      if (this.accept('&') || this.accept('&&')) { result.ref = true; continue; }
      break;
    }
    return result;
  }

  parseTemplateArgs(owner: string): TypeRef[] | null {
    this.expect('<');
    const args: TypeRef[] = [];
    if (owner === 'function') {
      // std::function<void(int)> - skip signature, treat as opaque callable
      let depth = 1;
      while (depth > 0 && this.cur.t !== 'eof') {
        if (this.isOp('<')) depth++;
        else if (this.isOp('>')) depth--;
        else if (this.isOp('>>')) depth -= 2;
        this.pos++;
      }
      return [];
    }
    for (;;) {
      if (this.cur.t === 'num') { this.pos++; } // array<int, 5>
      else {
        const t = this.parseTypeInner();
        if (!t) return null;
        args.push(t);
      }
      if (this.accept(',')) continue;
      break;
    }
    if (this.isOp('>>')) {
      // split ">>" into two ">" tokens
      this.toks.splice(this.pos, 1, { t: 'op', v: '>', line: this.cur.line }, { t: 'op', v: '>', line: this.cur.line });
    }
    if (!this.accept('>')) return null;
    return args;
  }

  /** Does a declaration (type + declarator name) start here? */
  looksLikeDecl(): boolean {
    if (!this.isTypeStart() || this.isId('sizeof')) return false;
    const save = this.pos;
    const t = this.parseTypeInner();
    let ok = false;
    if (t && this.cur.t === 'id' && !NONTYPE.has(this.cur.v)) {
      const known = PRIM.has(t.name) || this.knownTypes.has(t.name) || TEMPLATES.has(t.name) || this.aliases.has(t.name);
      const nxt = this.at(1);
      if (known) ok = true;
      else if (nxt.t === 'op' && ['=', ';', '(', '[', '{', ',', ':', ')'].includes(nxt.v)) ok = true;
    }
    this.pos = save;
    return ok;
  }

  // ---- declarations ----
  parseDeclOrFunc(out: Stmt[], top: boolean): void {
    const startTok = this.cur;
    const type = this.tryType();
    if (!type || this.cur.t !== 'id') {
      this.pos = this.toks.indexOf(startTok);
      // not a declaration at top level: parse a statement (e.g. stray expression)
      out.push(this.parseStmt());
      return;
    }
    // constructor-less function pointer parameters etc. are handled in params
    if (top && this.at(1).t === 'op' && this.at(1).v === '(' && this.looksLikeFunction()) {
      const name = this.ident();
      const fn = this.parseFunctionRest(type, name);
      if (fn) out.push(fn);
      return;
    }
    out.push(this.parseDeclarators(type));
    this.expect(';');
  }

  /** At `name (` - decide function definition/prototype versus constructor-style variable. */
  looksLikeFunction(): boolean {
    const save = this.pos;
    this.pos++; // name
    const open = this.pos;
    this.skipBalanced('(', ')');
    const after = this.cur;
    this.pos = save;
    if (after.t === 'op' && after.v === '{') return true;
    if (after.t === 'id' && (after.v === 'const' || after.v === 'noexcept' || after.v === 'override')) return true;
    if (after.t === 'op' && after.v === ';') {
      // prototype only if the parameter list looks like types
      const first = this.toks[open + 1];
      if (first.t === 'op' && first.v === ')') return true;
      if (first.t === 'id' && (PRIM.has(first.v) || this.knownTypes.has(first.v) || QUALS.has(first.v) || TEMPLATES.has(first.v))) return true;
    }
    return false;
  }

  parseParams(): Param[] {
    this.expect('(');
    const params: Param[] = [];
    if (this.isId('void') && this.isOp(')', 1)) { this.pos += 2; return params; }
    while (!this.isOp(')')) {
      if (this.accept('...')) { params.push({ name: 'args', star: 'args' }); break; }
      const type = this.tryType();
      if (!type) this.err(`Unexpected '${this.cur.v}' in parameter list`);
      let name = '';
      if (this.isOp('(') && this.isOp('*', 1)) {
        // function pointer parameter: ret (*name)(args)
        this.pos += 2;
        name = this.ident();
        this.expect(')');
        this.skipBalanced('(', ')');
      } else if (this.cur.t === 'id') {
        name = this.ident();
      }
      while (this.accept('[')) { while (!this.isOp(']') && this.cur.t !== 'eof') this.pos++; this.expect(']'); type.ptr = true; }
      const p: Param = { name: name || `_p${params.length}`, type };
      if (this.accept('=')) p.def = this.parseAssign();
      params.push(p);
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return params;
  }

  parseFunctionRest(ret: TypeRef, name: string): FuncDecl | null {
    const params = this.parseParams();
    while (this.cur.t === 'id' && ['const', 'noexcept', 'override', 'final'].includes(this.cur.v)) this.pos++;
    if (this.accept(';')) return null; // prototype
    const body = this.parseBlock();
    return { k: 'func', name, params, ret, body };
  }

  parseDeclarators(type: TypeRef): Stmt {
    const decls: Stmt[] = [];
    do {
      let t: TypeRef = { ...type };
      while (this.accept('*')) t.ptr = true;
      if (this.accept('&')) t.ref = true;
      const name = this.ident();
      const dims: (Expr | null)[] = [];
      while (this.accept('[')) {
        dims.push(this.isOp(']') ? null : this.parseAssign());
        this.expect(']');
      }
      if (dims.length) t = { ...t, dims };
      let init: Expr | undefined;
      let ctorArgs: Expr[] | undefined;
      if (this.accept('=')) init = this.isOp('{') ? this.parseInitList() : this.parseAssign();
      else if (this.isOp('{')) init = this.parseInitList();
      else if (this.isOp('(')) ctorArgs = this.parseArgs();
      decls.push({ k: 'var', type: t, name, init, ctorArgs });
    } while (this.accept(','));
    return decls.length === 1 ? decls[0] : { k: 'multi', decls };
  }

  parseInitList(): Expr {
    this.expect('{');
    const items: Expr[] = [];
    while (!this.isOp('}')) {
      items.push(this.isOp('{') ? this.parseInitList() : this.parseAssign());
      if (!this.accept(',')) break;
    }
    this.expect('}');
    return { k: 'list', items };
  }

  parseEnum(): Stmt {
    this.pos++; // enum
    if (this.isId('class') || this.isId('struct')) this.pos++;
    const name = this.cur.t === 'id' ? this.ident() : '_anon';
    this.knownTypes.add(name);
    if (this.accept(':')) this.tryType();
    this.expect('{');
    const members: { name: string; value?: Expr }[] = [];
    while (!this.isOp('}')) {
      const m = this.ident();
      const value = this.accept('=') ? this.parseAssign() : undefined;
      members.push({ name: m, value });
      if (!this.accept(',')) break;
    }
    this.expect('}');
    if (this.cur.t === 'id') this.pos++;
    this.expect(';');
    return { k: 'enum', name, members };
  }

  parseStruct(): StructDecl {
    const name = this.ident();
    this.knownTypes.add(name);
    let base: string | undefined;
    if (this.accept(':')) {
      while (this.isId('public') || this.isId('private') || this.isId('protected') || this.isId('virtual')) this.pos++;
      const bt = this.tryType();
      base = bt?.name;
    }
    this.expect('{');
    const decl: StructDecl = { k: 'struct', name, base, fields: [], methods: [], ctors: [] };
    while (!this.isOp('}')) {
      if (this.cur.t === 'eof') this.err("Missing closing '}' for struct/class");
      if (this.accept(';')) continue;
      if ((this.isId('public') || this.isId('private') || this.isId('protected')) && this.isOp(':', 1)) { this.pos += 2; continue; }
      if (this.isId('using') || this.isId('typedef')) { while (!this.isOp(';')) this.pos++; this.pos++; continue; }
      if (this.isId('enum')) { this.hoisted.push(this.parseEnum()); continue; }
      if ((this.isId('struct') || this.isId('class')) && this.at(1).t === 'id' && this.isOp('{', 2)) { this.pos++; this.hoisted.push(this.parseStruct()); continue; }
      if (this.isOp('~')) {
        this.pos += 2;
        this.skipBalanced('(', ')');
        if (this.isOp('{')) this.skipBalanced('{', '}'); else this.accept(';');
        continue;
      }
      if (this.isId('operator')) this.err('Conversion operators are not supported by the simulator');
      // constructor
      if (this.cur.t === 'id' && this.cur.v === name && this.isOp('(', 1)) {
        this.pos++;
        const params = this.parseParams();
        const ctorInit: { field: string; args: Expr[] }[] = [];
        if (this.accept(':')) {
          do {
            const field = this.ident();
            const args = this.isOp('{') ? (this.parseInitList() as { items: Expr[] }).items : this.parseArgs();
            ctorInit.push({ field, args });
          } while (this.accept(','));
        }
        let body: Stmt[] = [];
        if (this.isOp('{')) body = this.parseBlock();
        else { this.accept('='); if (this.cur.t === 'id') this.pos++; this.expect(';'); }
        decl.ctors.push({ k: 'func', name: '__init__', params, body, isCtor: true, ctorInit });
        continue;
      }
      const type = this.tryType();
      if (!type || this.cur.t !== 'id') this.err(`Unexpected '${this.cur.v}' inside struct/class ${name}`);
      if (this.isId('operator')) {
        // operator overloading: operator== etc. become methods named op_eq, op_ne, ...
        this.pos++;
        const sym = this.cur.v;
        const opName = OPERATOR_NAMES[sym];
        if (!opName || (this.cur.t as string) !== 'op') this.err(`Operator '${sym}' overloading is not supported by the simulator`);
        this.pos++;
        const fn = this.parseFunctionRest(type, `op_${opName}`);
        if (fn) decl.methods.push(fn);
        continue;
      }
      if (this.at(1).t === 'op' && this.at(1).v === '(') {
        const mname = this.ident();
        const fn = this.parseFunctionRest(type, mname);
        if (fn) decl.methods.push(fn);
        continue;
      }
      const d = this.parseDeclarators(type);
      this.expect(';');
      const vars = d.k === 'multi' ? d.decls : [d];
      for (const v of vars) {
        if (v.k === 'var') {
          const f: FieldDecl = { type: v.type, name: v.name, init: v.init };
          decl.fields.push(f);
        }
      }
    }
    this.expect('}');
    // optional trailing variable declarators are not supported; consume until ';'
    while (!this.isOp(';') && this.cur.t !== 'eof') this.pos++;
    this.expect(';');
    return decl;
  }

  // ---- statements ----
  parseBlock(): Stmt[] {
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.isOp('}')) {
      if (this.cur.t === 'eof') this.err("Missing closing '}'");
      body.push(this.parseStmt());
    }
    this.expect('}');
    return body;
  }

  parseBody(): Stmt[] {
    if (this.isOp('{')) return this.parseBlock();
    return [this.parseStmt()];
  }

  parseStmt(): Stmt {
    const line = this.cur.line;
    const s = this.parseStmtInner();
    s.line ??= line;
    return s;
  }

  private parseStmtInner(): Stmt {
    const t = this.cur;
    if (t.t === 'op') {
      if (t.v === '{') return { k: 'block', body: this.parseBlock() };
      if (t.v === ';') { this.pos++; return { k: 'pass' }; }
    }
    if (t.t === 'id') {
      switch (t.v) {
        case 'if': return this.parseIf();
        case 'while': {
          this.pos++;
          this.expect('(');
          const test = this.parseExpr();
          this.expect(')');
          return { k: 'while', test, body: this.parseBody() };
        }
        case 'do': {
          this.pos++;
          const body = this.parseBody();
          if (!this.isId('while')) this.err("Expected 'while' after do-block");
          this.pos++;
          this.expect('(');
          const test = this.parseExpr();
          this.expect(')');
          this.expect(';');
          return { k: 'dowhile', test, body };
        }
        case 'for': return this.parseFor();
        case 'switch': return this.parseSwitch();
        case 'return': {
          this.pos++;
          let e: Expr | undefined;
          if (!this.isOp(';')) e = this.isOp('{') ? this.parseInitList() : this.parseExpr();
          this.expect(';');
          return { k: 'return', e };
        }
        case 'break': this.pos++; this.expect(';'); return { k: 'break' };
        case 'continue': this.pos++; this.expect(';'); return { k: 'continue' };
        case 'throw': {
          this.pos++;
          const e = this.isOp(';') ? undefined : this.parseExpr();
          this.expect(';');
          return { k: 'throw', e };
        }
        case 'try': return this.parseTry();
        case 'using': this.parseUsing(); return { k: 'pass' };
        case 'typedef': this.parseTypedef(); return { k: 'pass' };
        case 'enum': return this.parseEnum();
        case 'struct':
        case 'class':
          if (this.at(1).t === 'id' && (this.isOp('{', 2) || this.isOp(':', 2))) { this.pos++; return this.parseStruct(); }
          break;
      }
    }
    if (this.looksLikeDecl()) {
      const type = this.tryType() as TypeRef;
      const d = this.parseDeclarators(type);
      this.expect(';');
      return d;
    }
    const e = this.parseExpr();
    this.expect(';');
    return { k: 'expr', e };
  }

  parseTry(): Stmt {
    this.pos++;
    const body = this.parseBlock();
    let catchVar: string | undefined;
    let handler: Stmt[] | undefined;
    if (this.isId('catch')) {
      this.pos++;
      this.expect('(');
      if (!this.accept('...')) {
        this.tryType();
        if (this.cur.t === 'id') catchVar = this.ident();
      }
      this.expect(')');
      handler = this.parseBlock();
    }
    return { k: 'try', body, catchVar, handler };
  }

  parseIf(): Stmt {
    this.pos++;
    this.expect('(');
    const test = this.parseExpr();
    this.expect(')');
    const then = this.parseBody();
    let els: Stmt[] | undefined;
    if (this.isId('else')) {
      this.pos++;
      els = this.isId('if') ? [this.parseIf()] : this.parseBody();
    }
    return { k: 'if', test, then, else: els };
  }

  parseFor(): Stmt {
    this.pos++;
    this.expect('(');
    // range-based for?
    const save = this.pos;
    const rt = this.tryType();
    if (rt && this.cur.t === 'id' && this.isOp(':', 1)) {
      const v = this.ident();
      this.pos++; // ':'
      const iter = this.isOp('{') ? this.parseInitList() : this.parseExpr();
      this.expect(')');
      return { k: 'forin', vars: [v], type: rt, iter, body: this.parseBody() };
    }
    this.pos = save;
    let init: Stmt | undefined;
    if (!this.isOp(';')) {
      if (this.looksLikeDecl()) init = this.parseDeclarators(this.tryType() as TypeRef);
      else init = { k: 'expr', e: this.parseExpr() };
    }
    this.expect(';');
    const test = this.isOp(';') ? undefined : this.parseExpr();
    this.expect(';');
    const update = this.isOp(')') ? undefined : this.parseExpr();
    this.expect(')');
    return { k: 'for', init, test, update, body: this.parseBody() };
  }

  parseSwitch(): Stmt {
    this.pos++;
    this.expect('(');
    const disc = this.parseExpr();
    this.expect(')');
    this.expect('{');
    const cases: { test?: Expr; body: Stmt[] }[] = [];
    while (!this.isOp('}')) {
      let test: Expr | undefined;
      if (this.isId('case')) {
        this.pos++;
        test = this.parseCond();
      } else if (this.isId('default')) {
        this.pos++;
      } else this.err(`Expected 'case' or 'default' but found '${this.cur.v}'`);
      this.expect(':');
      const body: Stmt[] = [];
      while (!this.isOp('}') && !this.isId('case') && !this.isId('default')) {
        if (this.cur.t === 'eof') this.err("Missing closing '}' for switch");
        body.push(this.parseStmt());
      }
      cases.push({ test, body });
    }
    this.expect('}');
    return { k: 'switch', disc, cases };
  }

  // ---- expressions ----
  parseExpr(): Expr {
    let e = this.parseAssign();
    while (this.isOp(',')) {
      this.pos++;
      e = { k: 'bin', op: ',', l: e, r: this.parseAssign() };
    }
    return e;
  }

  parseAssign(): Expr {
    const lhs = this.parseCond();
    if (this.cur.t === 'op' && ASSIGN_OPS.has(this.cur.v)) {
      const op = this.cur.v;
      this.pos++;
      const value = this.isOp('{') ? this.parseInitList() : this.parseAssign();
      return { k: 'assign', op, target: lhs, value };
    }
    return lhs;
  }

  parseCond(): Expr {
    const test = this.parseBin(1);
    if (this.accept('?')) {
      const a = this.parseAssign();
      this.expect(':');
      const b = this.parseAssign();
      return { k: 'cond', test, a, b };
    }
    return test;
  }

  parseBin(min: number): Expr {
    let l = this.parseUnary();
    for (;;) {
      const t = this.cur;
      if (t.t !== 'op') break;
      const prec = BIN_PREC[t.v];
      if (prec === undefined || prec < min) break;
      this.pos++;
      const r = this.parseBin(prec + 1);
      l = { k: 'bin', op: t.v, l, r };
    }
    return l;
  }

  startsOperand(): boolean {
    const t = this.cur;
    if (t.t === 'id' || t.t === 'num' || t.t === 'str' || t.t === 'char') return true;
    return t.t === 'op' && ['(', '-', '+', '!', '~', '*', '&', '++', '--'].includes(t.v);
  }

  parseUnary(): Expr {
    const t = this.cur;
    if (t.t === 'op') {
      if (t.v === '!' || t.v === '-' || t.v === '+' || t.v === '~' || t.v === '*' || t.v === '&') {
        this.pos++;
        return { k: 'unary', op: t.v, arg: this.parseUnary() };
      }
      if (t.v === '++' || t.v === '--') {
        this.pos++;
        return { k: 'update', op: t.v, prefix: true, arg: this.parseUnary() };
      }
      if (t.v === '(') {
        // C-style cast of a primitive type
        const save = this.pos;
        this.pos++;
        const ty = this.tryType();
        if (ty && this.isOp(')') && (PRIM.has(ty.name) || this.aliases.has(ty.name))) {
          this.pos++;
          if (this.startsOperand()) return { k: 'cast', type: ty, arg: this.parseUnary() };
        }
        this.pos = save;
      }
    }
    if (t.t === 'id' && t.v === 'sizeof') {
      this.pos++;
      this.expect('(');
      const save = this.pos;
      const ty = this.tryType();
      let arg: Expr;
      if (ty && this.isOp(')') && (PRIM.has(ty.name) || this.knownTypes.has(ty.name))) arg = { k: 'str', v: ty.name };
      else {
        this.pos = save;
        arg = this.parseExpr();
      }
      this.expect(')');
      return { k: 'call', callee: { k: 'id', name: 'sizeof' }, args: [arg] };
    }
    return this.parsePostfix();
  }

  parseArgs(): Expr[] {
    this.expect('(');
    const args: Expr[] = [];
    while (!this.isOp(')')) {
      args.push(this.isOp('{') ? this.parseInitList() : this.parseAssign());
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return args;
  }

  parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp('(')) {
        e = { k: 'call', callee: e, args: this.parseArgs() };
      } else if (this.isOp('[')) {
        this.pos++;
        const idx = this.parseExpr();
        this.expect(']');
        e = { k: 'index', obj: e, idx };
      } else if (this.isOp('.') || this.isOp('->')) {
        this.pos++;
        if (this.isId('template')) this.pos++;
        e = { k: 'member', obj: e, prop: this.ident() };
      } else if (this.isOp('++') || this.isOp('--')) {
        const op = this.cur.v as '++' | '--';
        this.pos++;
        e = { k: 'update', op, prefix: false, arg: e };
      } else break;
    }
    return e;
  }

  parsePrimary(): Expr {
    const t = this.cur;
    switch (t.t) {
      case 'num': this.pos++; return { k: 'num', v: t.num as number, int: !!t.int };
      case 'str': this.pos++; return { k: 'str', v: t.v };
      case 'char': this.pos++; return { k: 'char', v: t.v };
      case 'op':
        if (t.v === '(') {
          this.pos++;
          const e = this.parseExpr();
          this.expect(')');
          return e;
        }
        if (t.v === '[') return this.parseLambda();
        if (t.v === '{') return this.parseInitList();
        break;
      case 'id': {
        if (t.v === 'true' || t.v === 'false') { this.pos++; return { k: 'bool', v: t.v === 'true' }; }
        if (t.v === 'nullptr' || t.v === 'NULL') { this.pos++; return { k: 'null' }; }
        if (CAST_KW.has(t.v) && this.isOp('<', 1)) {
          this.pos += 2;
          const ty = this.parseTypeInner();
          if (!ty) this.err('Expected a type in cast');
          this.expect('>');
          this.expect('(');
          const arg = this.parseExpr();
          this.expect(')');
          return { k: 'cast', type: ty, arg };
        }
        // qualified name: std::string::npos, vex::color::red ...
        const segs: string[] = [t.v];
        this.pos++;
        while (this.isOp('::') && this.at(1).t === 'id') { this.pos++; segs.push(this.cur.v); this.pos++; }
        while (segs.length > 1 && DROP_NS.has(segs[0])) segs.shift();
        let e: Expr = { k: 'id', name: segs[0] };
        for (let i = 1; i < segs.length; i++) e = { k: 'member', obj: e, prop: segs[i] };
        // Type{...} brace construction
        if (segs.length === 1 && this.isOp('{') && (this.knownTypes.has(segs[0]) || PRIM.has(segs[0]) || TEMPLATES.has(segs[0]))) {
          const list = this.parseInitList() as { k: 'list'; items: Expr[] };
          return { k: 'call', callee: e, args: list.items };
        }
        return e;
      }
    }
    this.err(`Unexpected '${t.v || 'end of file'}'`);
  }

  parseLambda(): Expr {
    this.expect('[');
    while (!this.isOp(']') && this.cur.t !== 'eof') this.pos++;
    this.expect(']');
    const params = this.isOp('(') ? this.parseParams() : [];
    while (this.isId('mutable') || this.isId('noexcept')) this.pos++;
    if (this.accept('->')) this.tryType();
    const body = this.parseBlock();
    return { k: 'lambda', params, body };
  }
}

export function parseCpp(src: string): Program {
  return new CppParser(src).parseProgram();
}
