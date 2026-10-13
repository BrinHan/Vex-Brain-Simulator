import { Expr, FuncDecl, Param, Program, Stmt, StructDecl, SyntaxErr, TypeRef } from './ast';

/**
 * Translates the shared AST to JavaScript source. Every user function is `async` and every call is awaited,
 * so `wait()` can suspend a program and `$.tick()` in loops lets the UI stay responsive and a run be stopped.
 * Runtime helpers live on the `$` object (see runtime/helpers.ts); VEX API globals are destructured from `$g`.
 */

const INTS = new Set(['int', 'long', 'short', 'size_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t']);
const FLOATS = new Set(['double', 'float']);
const DEVICES = new Set([
  'brain', 'controller', 'motor', 'motor_group', 'inertial', 'competition', 'digital_out', 'digital_in', 'analog_in', 'analog_out',
  'encoder', 'optical', 'distance', 'rotation', 'vision', 'gps', 'limit', 'bumper', 'led', 'pot', 'line', 'triport', 'pneumatics',
  'gyro', 'sonar', 'aivision', 'pwm_out', 'signature', 'code', 'competition_t',
]);
const JS_RESERVED = new Set([
  'var', 'function', 'let', 'new', 'delete', 'typeof', 'void', 'with', 'yield', 'await', 'export', 'import', 'package',
  'interface', 'static', 'implements', 'arguments', 'eval', 'in', 'instanceof', 'super', 'enum', 'const', 'debugger',
  'catch', 'finally', 'extends', 'null', 'undefined', 'NaN', 'Infinity', 'Object', 'Array', 'Math', 'String', 'Number', 'Promise',
]);
// member calls whose result is an integer (used for C++ integer division)
const INT_RESULT_METHODS = new Set(['xPosition', 'yPosition', 'size', 'length', 'time', 'row', 'column', 'capacity', 'getStringWidth', 'getStringHeight']);
const ARITH = new Set(['+', '-', '*', '/', '%']);
const OPERATOR_METHODS: Record<string, string> = {
  '==': 'eq', '!=': 'ne', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge', '+': 'add', '-': 'sub', '*': 'mul', '/': 'div',
};
const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!=', '&&', '||', 'in', 'not in', 'is', 'is not']);

type T = TypeRef | undefined;

class Scopes {
  stack: Map<string, T>[] = [new Map()];
  push(): void { this.stack.push(new Map()); }
  pop(): void { this.stack.pop(); }
  set(name: string, t: T): void { this.stack[this.stack.length - 1].set(name, t); }
  has(name: string): boolean { return this.stack.some((m) => m.has(name)); }
  get(name: string): T {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const m = this.stack[i];
      if (m.has(name)) return m.get(name);
    }
    return undefined;
  }
}

const mangle = (n: string): string => (JS_RESERVED.has(n) ? `${n}$` : n);
const q = (s: string): string => JSON.stringify(s);

function containsCall(e: Expr | Stmt[]): boolean {
  if (Array.isArray(e)) return true;
  let found = false;
  const walk = (x: Expr): void => {
    if (found) return;
    switch (x.k) {
      case 'call': case 'listcomp': case 'update': case 'assign': found = true; return;
      case 'member': walk(x.obj); return;
      case 'index': walk(x.obj); walk(x.idx); return;
      case 'slice': walk(x.obj); if (x.lo) walk(x.lo); if (x.hi) walk(x.hi); if (x.step) walk(x.step); return;
      case 'unary': walk(x.arg); return;
      case 'bin': walk(x.l); walk(x.r); return;
      case 'cond': walk(x.test); walk(x.a); walk(x.b); return;
      case 'list': x.items.forEach(walk); return;
      case 'dict': x.entries.forEach(([a, b]) => { walk(a); walk(b); }); return;
      case 'fstr': x.parts.forEach((p) => { if (typeof p !== 'string') walk(p.e); }); return;
      case 'cast': walk(x.arg); return;
      case 'lambda': return;
      default: return;
    }
  };
  walk(e);
  return found;
}

export class Codegen {
  lang: 'cpp' | 'py';
  scopes = new Scopes();
  structs = new Map<string, StructDecl>();
  funcs = new Map<string, FuncDecl>();
  currentStruct?: StructDecl;
  enums = new Set<string>();
  retType: T;
  funcDepth = 0;
  statics: string[] = [];
  tmp = 0;

  constructor(private prog: Program) {
    this.lang = prog.lang;
  }

  // ------------------------------------------------------------ prepass
  private prepass(stmts: Stmt[]): void {
    for (const s of stmts) {
      if (s.k === 'struct') this.structs.set(s.name, s);
      else if (s.k === 'enum') this.enums.add(s.name);
      else if (s.k === 'func') {
        this.funcs.set(s.name, s);
        this.prepass(s.body);
      } else if (s.k === 'block') this.prepass(s.body);
    }
  }

  generate(_globalNames: string[], entry?: string): string {
    this.prepass(this.prog.body);
    const body = this.prog.body;
    let code = '';
    if (this.lang === 'py') {
      const hoist = new Set<string>();
      this.collectAssigned(body, hoist);
      this.collectAllGlobals(body, hoist);
      for (const s of body) if (s.k === 'func' || s.k === 'struct') hoist.delete(s.name);
      if (hoist.size) code += `let ${[...hoist].map(mangle).join(', ')};\n`;
    }
    code += this.stmts(body);
    const start = entry ?? 'main';
    if (this.lang === 'cpp' && this.funcs.has(start)) code += `await ${mangle(start)}();\n`;
    if (this.statics.length) code = `let ${this.statics.join(', ')};\n${code}`;
    // `$g` is a scope proxy (see runtime): VEX API names resolve to the simulator and unknown names become stubs
    return `with ($g) {\nreturn (async () => {\n${code}})();\n}`;
  }

  // ------------------------------------------------------------ python scoping helpers
  private collectAssigned(stmts: Stmt[], out: Set<string>): void {
    const target = (t: Expr): void => {
      if (t.k === 'id') out.add(t.name);
      else if (t.k === 'list') t.items.forEach(target);
    };
    const expr = (e: Expr): void => {
      if (e.k === 'assign') { target(e.target); expr(e.value); }
    };
    for (const s of stmts) {
      switch (s.k) {
        case 'expr': expr(s.e); break;
        case 'forin': s.vars.forEach((v) => out.add(v)); this.collectAssigned(s.body, out); break;
        case 'if': this.collectAssigned(s.then, out); if (s.else) this.collectAssigned(s.else, out); break;
        case 'while': case 'dowhile': case 'block': this.collectAssigned(s.body, out); break;
        case 'for': this.collectAssigned(s.body, out); break;
        case 'try':
          this.collectAssigned(s.body, out);
          if (s.catchVar) out.add(s.catchVar);
          if (s.handler) this.collectAssigned(s.handler, out);
          if (s.fin) this.collectAssigned(s.fin, out);
          break;
        case 'multi': this.collectAssigned(s.decls, out); break;
        default: break;
      }
    }
  }

  private collectGlobals(stmts: Stmt[], out: Set<string>): void {
    for (const s of stmts) {
      if (s.k === 'global') s.names.forEach((n) => out.add(n));
      else if (s.k === 'if') { this.collectGlobals(s.then, out); if (s.else) this.collectGlobals(s.else, out); }
      else if (s.k === 'while' || s.k === 'forin' || s.k === 'block' || s.k === 'for') this.collectGlobals(s.body, out);
      else if (s.k === 'try') { this.collectGlobals(s.body, out); if (s.handler) this.collectGlobals(s.handler, out); if (s.fin) this.collectGlobals(s.fin, out); }
    }
  }

  private collectAllGlobals(stmts: Stmt[], out: Set<string>): void {
    for (const s of stmts) {
      if (s.k === 'func') { this.collectGlobals(s.body, out); this.collectAllGlobals(s.body, out); }
      else if (s.k === 'struct') s.methods.forEach((m) => { this.collectGlobals(m.body, out); this.collectAllGlobals(m.body, out); });
      else if (s.k === 'if') { this.collectAllGlobals(s.then, out); if (s.else) this.collectAllGlobals(s.else, out); }
      else if (s.k === 'while' || s.k === 'forin' || s.k === 'block' || s.k === 'for') this.collectAllGlobals(s.body, out);
      else if (s.k === 'try') { this.collectAllGlobals(s.body, out); if (s.handler) this.collectAllGlobals(s.handler, out); }
    }
  }

  // ------------------------------------------------------------ types
  private resolve(t: T): T { return t; }
  private isInt(t: T): boolean { return !!t && !t.ptr && !t.dims && (INTS.has(t.name) || this.enums.has(t.name)); }
  private isCharPtr(t: T): boolean { return !!t && t.name === 'char' && (!!t.ptr || (!!t.dims && t.dims.length === 1)); }
  private isFloat(t: T): boolean { return !!t && !t.ptr && !t.dims && FLOATS.has(t.name); }
  private isChar(e: Expr): boolean { return e.k === 'char' || (e.k === 'id' && this.scopes.get(e.name)?.name === 'char'); }
  private structOf(t: T): StructDecl | undefined { return t && !t.dims ? this.structs.get(t.name) : undefined; }

  private elemType(t: T): T {
    if (!t) return undefined;
    if (t.dims) return t.dims.length > 1 ? { ...t, dims: t.dims.slice(1) } : { ...t, dims: undefined };
    if (t.name === 'string') return { name: 'char' };
    if ((t.name === 'vector' || t.name === 'array') && t.args?.[0]) return t.args[0];
    return undefined;
  }

  private findField(st: StructDecl | undefined, name: string): { type?: TypeRef } | undefined {
    for (let s = st; s; s = s.base ? this.structs.get(s.base) : undefined) {
      const f = s.fields.find((x) => x.name === name);
      if (f) return f;
      const m = s.methods.find((x) => x.name === name);
      if (m) return { type: undefined };
    }
    return undefined;
  }

  private findMethod(st: StructDecl | undefined, name: string): FuncDecl | undefined {
    for (let s = st; s; s = s.base ? this.structs.get(s.base) : undefined) {
      const m = s.methods.find((x) => x.name === name);
      if (m) return m;
    }
    return undefined;
  }

  inferType(e: Expr): T {
    switch (e.k) {
      case 'num': return { name: e.int ? 'int' : 'double' };
      case 'str': return { name: 'string' };
      case 'char': return { name: 'char' };
      case 'bool': return { name: 'bool' };
      case 'fstr': return { name: 'string' };
      case 'id': {
        if (this.scopes.has(e.name)) return this.scopes.get(e.name);
        if (this.currentStruct) return this.findField(this.currentStruct, e.name)?.type;
        return undefined;
      }
      case 'unary':
        if (e.op === '!') return { name: 'bool' };
        if (e.op === '*' || e.op === '&') return this.inferType(e.arg);
        { const t = this.inferType(e.arg); return t?.name === 'char' ? { name: 'int' } : t; }
      case 'update': return this.inferType(e.arg);
      case 'assign': return this.inferType(e.target);
      case 'cond': return this.inferType(e.a);
      case 'cast': return e.type;
      case 'index': return this.elemType(this.inferType(e.obj));
      case 'member': {
        const ot = this.inferType(e.obj);
        const st = this.structOf(ot) ?? (e.obj.k === 'id' && e.obj.name === 'this' ? this.currentStruct : undefined);
        return this.findField(st, e.prop)?.type;
      }
      case 'bin': {
        if (CMP_OPS.has(e.op)) return { name: 'bool' };
        if (e.op === ',') return this.inferType(e.r);
        if (!ARITH.has(e.op) && !['<<', '>>', '&', '|', '^'].includes(e.op)) return undefined;
        const lt = this.inferType(e.l);
        const rt = this.inferType(e.r);
        if (e.op === '+' && (lt?.name === 'string' || rt?.name === 'string')) return { name: 'string' };
        if (this.isFloat(lt) || this.isFloat(rt)) return { name: 'double' };
        const intish = (t: T): boolean => this.isInt(t) || t?.name === 'bool' || t?.name === 'char';
        if (intish(lt) && intish(rt)) return { name: 'int' };
        return undefined;
      }
      case 'call': {
        const c = e.callee;
        if (c.k === 'id') {
          const f = this.funcs.get(c.name);
          if (f && !this.scopes.has(c.name)) return f.ret;
          if (this.structs.has(c.name)) return { name: c.name };
          if (['sqrt', 'pow', 'sin', 'cos', 'tan', 'atan2', 'fabs', 'floor', 'ceil', 'stod', 'atan', 'asin', 'acos', 'exp', 'log', 'double', 'float'].includes(c.name)) return { name: 'double' };
          if (['int', 'stoi', 'rand'].includes(c.name)) return { name: 'int' };
          if (['string', 'to_string'].includes(c.name)) return { name: 'string' };
          if (this.currentStruct) { const m = this.findMethod(this.currentStruct, c.name); if (m) return m.ret; }
        } else if (c.k === 'member') {
          if (INT_RESULT_METHODS.has(c.prop)) return { name: 'int' };
          const st = this.structOf(this.inferType(c.obj)) ?? (c.obj.k === 'id' && c.obj.name === 'this' ? this.currentStruct : undefined);
          return this.findMethod(st, c.prop)?.ret;
        }
        return undefined;
      }
      default: return undefined;
    }
  }

  // ------------------------------------------------------------ defaults and initialisers
  private defaultValue(t: T): string {
    if (!t) return 'null';
    if (t.ptr) return 'null';
    if (t.dims && t.name === 'char' && t.dims.length === 1) return `$.cbuf(${t.dims[0] ? this.expr(t.dims[0]) : '0'})`;
    if (t.dims) {
      const rest = this.elemType(t);
      const size = t.dims[0] ? this.expr(t.dims[0]) : '0';
      return `(await $.mkarr(${size}, async () => ${this.defaultValue(rest)}))`;
    }
    if (INTS.has(t.name) || FLOATS.has(t.name) || this.enums.has(t.name)) return '0';
    switch (t.name) {
      case 'bool': return 'false';
      case 'string': case 'char': return '""';
      case 'vector': case 'array': case 'deque': case 'list': return '[]';
      case 'map': case 'unordered_map': return '$.map()';
      case 'auto': case 'void': return 'null';
    }
    if (this.structs.has(t.name)) return `(await $.new(${mangle(t.name)}, []))`;
    // anything else (vex::mutex, vex::timer, color ...) is built by the simulator's library, or stubbed
    return `(await $.make(${q(t.name)}, []))`;
  }

  private coerce(t: T, e: Expr, js: string): string {
    if (!t || t.dims || t.ptr) return js;
    if (this.isInt(t)) {
      const et = this.inferType(e);
      if (this.isFloat(et)) return `Math.trunc(${js})`;
      if (e.k === 'char') return `$.ord(${js})`;
    }
    if (this.structOf(t) && !t.ref && (e.k === 'id' || e.k === 'member' || e.k === 'index')) return `$.copy(${js})`;
    if ((t.name === 'vector' || t.name === 'array') && !t.ref && (e.k === 'id' || e.k === 'member')) return `$.copy(${js})`;
    return js;
  }

  private init(e: Expr, t: T): string {
    if (e.k === 'list' && this.lang === 'cpp') {
      if (this.isCharPtr(t) && t?.dims && e.items.length === 0) return this.defaultValue(t);
      if (t?.dims) {
        const et = this.elemType(t);
        const items = `[${e.items.map((i) => this.init(i, et)).join(', ')}]`;
        const size = t.dims[0];
        return size ? `(await $.fill(${items}, ${this.expr(size)}, async () => ${this.defaultValue(et)}))` : items;
      }
      const st = this.structOf(t);
      if (st) {
        const fields = this.allFields(st);
        return `(await $.new(${st.name}, [${e.items.map((i, idx) => this.init(i, fields[idx]?.type)).join(', ')}]))`;
      }
      const et = t?.args?.[0];
      return `[${e.items.map((i) => this.init(i, et)).join(', ')}]`;
    }
    return this.coerce(t, e, this.expr(e));
  }

  private allFields(st: StructDecl): { name: string; type?: TypeRef }[] {
    const base = st.base ? this.structs.get(st.base) : undefined;
    return [...(base ? this.allFields(base) : []), ...st.fields];
  }

  // ------------------------------------------------------------ statements
  stmts(list: Stmt[]): string {
    return list.map((s) => this.stmt(s)).join('');
  }

  private block(list: Stmt[], extra = ''): string {
    this.scopes.push();
    const body = this.stmts(list);
    this.scopes.pop();
    return `{\n${extra}${body}}`;
  }

  private loopBody(list: Stmt[]): string {
    return this.block(list, 'await $.tick();\n');
  }

  stmt(s: Stmt): string {
    switch (s.k) {
      case 'pass': return '';
      case 'expr': return `${this.expr(s.e, true)};\n`;
      case 'var': return this.varDecl(s) + ';\n';
      case 'multi': return s.decls.map((d) => this.stmt(d)).join('');
      case 'block': return this.block(s.body) + '\n';
      case 'if': {
        let out = `if (${this.cond(s.test)}) ${this.block(s.then)}`;
        if (s.else) out += ` else ${this.block(s.else)}`;
        return out + '\n';
      }
      case 'while': return `while (${this.cond(s.test)}) ${this.loopBody(s.body)}\n`;
      case 'dowhile': return `do ${this.loopBody(s.body)} while (${this.cond(s.test)});\n`;
      case 'for': return this.forStmt(s);
      case 'forin': return this.forIn(s);
      case 'return':
        if (!s.e) return 'return;\n';
        return `return ${s.e.k === 'list' && this.lang === 'cpp' ? this.init(s.e, this.retType) : this.expr(s.e)};\n`;
      case 'break': return 'break;\n';
      case 'continue': return 'continue;\n';
      case 'global': return '';
      case 'throw': return `throw $.pyerr(${s.e ? this.expr(s.e) : '"error"'});\n`;
      case 'try': {
        let out = `try ${this.block(s.body)}`;
        if (s.handler) {
          this.scopes.push();
          if (s.catchVar) this.scopes.set(s.catchVar, undefined);
          const bind = s.catchVar ? `${this.lang === 'py' ? '' : 'let '}${mangle(s.catchVar)} = $.errval($e);\n` : '';
          const h = this.stmts(s.handler);
          this.scopes.pop();
          out += ` catch ($e) {\nif ($.isStop($e)) throw $e;\n${bind}${h}}`;
        }
        if (s.fin) out += ` finally ${this.block(s.fin)}`;
        return out + '\n';
      }
      case 'switch': return this.switchStmt(s);
      case 'enum': return this.enumDecl(s);
      case 'func': return this.funcDecl(s);
      case 'struct': return this.structDecl(s);
    }
  }

  private varDecl(s: Extract<Stmt, { k: 'var' }>): string {
    const name = mangle(s.name);
    let t = s.type;
    if (t && DEVICES.has(t.name) && !t.dims) {
      const args = s.ctorArgs ?? (s.init && s.init.k === 'call' ? s.init.args : []);
      this.scopes.set(s.name, t);
      return `let ${name} = $.device(${q(t.name)}, ${q(s.name)}, [${args.map((a) => this.expr(a)).join(', ')}])`;
    }
    if (!t) {
      this.scopes.set(s.name, undefined);
      return `let ${name} = ${s.init ? this.expr(s.init) : 'null'}`;
    }
    if (t.name === 'auto') {
      const it = s.init ? this.inferType(s.init) : undefined;
      t = it ? { ...it, ref: t.ref } : { name: 'auto' };
    }
    let alias: string | undefined;
    if (t.isStatic && this.funcDepth > 0) {
      alias = `$st${this.statics.length}`;
      this.statics.push(alias);
    }
    this.scopes.set(s.name, alias ? { ...t, alias } : t);
    let value: string;
    if (s.init) value = this.init(s.init, t);
    else if (s.ctorArgs) {
      const args = s.ctorArgs.map((a) => this.expr(a));
      if (this.structs.has(t.name)) value = `(await $.new(${mangle(t.name)}, [${args.join(', ')}]))`;
      else if (t.name === 'vector' || t.name === 'array') value = `$.vec(${args.join(', ')})`;
      else value = `(await $.make(${q(t.name)}, [${args.join(', ')}]))`;
    } else value = this.defaultValue(t);
    // a static local is initialised once, on first execution, and lives for the whole run
    if (alias) return `if (${alias} === undefined) ${alias} = ${value}`;
    return `let ${name} = ${value}`;
  }

  private forStmt(s: Extract<Stmt, { k: 'for' }>): string {
    this.scopes.push();
    let init = '';
    if (s.init) {
      const decls = s.init.k === 'multi' ? s.init.decls : [s.init];
      if (decls[0].k === 'var') {
        init = 'let ' + decls.map((d) => this.varDecl(d as Extract<Stmt, { k: 'var' }>).replace(/^let /, '')).join(', ');
      } else if (decls[0].k === 'expr') init = this.expr(decls[0].e, true);
    }
    const test = s.test ? this.cond(s.test) : '';
    const update = s.update ? this.expr(s.update, true) : '';
    const body = this.loopBody(s.body);
    this.scopes.pop();
    return `for (${init}; ${test}; ${update}) ${body}\n`;
  }

  private forIn(s: Extract<Stmt, { k: 'forin' }>): string {
    // python: for i in range(...)
    if (this.lang === 'py' && s.vars.length === 1 && s.iter.k === 'call' && s.iter.callee.k === 'id' && s.iter.callee.name === 'range' &&
      !this.scopes.has('range') && !s.iter.kwargs && s.iter.args.length >= 1 && s.iter.args.length <= 3) {
      const a = s.iter.args;
      const v = mangle(s.vars[0]);
      const start = a.length >= 2 ? this.expr(a[0]) : '0';
      const stopE = a.length >= 2 ? a[1] : a[0];
      const stepE = a[2];
      const stepNeg = !!stepE && stepE.k === 'unary' && stepE.op === '-' && stepE.arg.k === 'num';
      const stepPos = !stepE || (stepE.k === 'num' && stepE.v > 0);
      if (stepPos || stepNeg) {
        const e = `$e${this.tmp++}`;
        const step = stepE ? this.expr(stepE) : '1';
        const cmp = stepNeg ? '>' : '<';
        const body = this.loopBody(s.body);
        return `{ const ${e} = ${this.expr(stopE)};\nfor (${v} = ${start}; ${v} ${cmp} ${e}; ${v} += ${step}) ${body} }\n`;
      }
    }
    const it = `$.iter(${this.expr(s.iter)})`;
    if (this.lang === 'py') {
      if (s.vars.length === 1) return `for (${mangle(s.vars[0])} of ${it}) ${this.loopBody(s.body)}\n`;
      const tv = `$v${this.tmp++}`;
      return `for (const ${tv} of ${it}) {\n[${s.vars.map(mangle).join(', ')}] = $.unpack(${tv});\nawait $.tick();\n${this.stmts(s.body)}}\n`;
    }
    this.scopes.push();
    let et: T = s.type;
    if (et && et.name === 'auto') et = this.elemType(this.inferType(s.iter));
    this.scopes.set(s.vars[0], et);
    const body = this.loopBody(s.body);
    this.scopes.pop();
    return `for (let ${mangle(s.vars[0])} of ${it}) ${body}\n`;
  }

  private switchStmt(s: Extract<Stmt, { k: 'switch' }>): string {
    let out = `switch (${this.expr(s.disc)}) {\n`;
    for (const c of s.cases) {
      out += c.test ? `case ${this.expr(c.test)}: ` : 'default: ';
      out += this.block(c.body) + '\n';
    }
    return out + '}\n';
  }

  private enumDecl(s: Extract<Stmt, { k: 'enum' }>): string {
    let out = `const ${mangle(s.name)} = (() => { const o = {}; let n = -1;\n`;
    for (const m of s.members) out += `o[${q(m.name)}] = n = ${m.value ? this.expr(m.value) : 'n + 1'};\n`;
    out += 'return o; })();\n';
    for (const m of s.members) out += `var ${mangle(m.name)} = ${mangle(s.name)}[${q(m.name)}];\n`;
    this.scopes.set(s.name, { name: 'int' });
    for (const m of s.members) this.scopes.set(m.name, { name: 'int' });
    return out;
  }

  private params(params: Param[], dropSelf: boolean): { sig: string; prologue: string; list: Param[] } {
    const list = dropSelf ? params.slice(1) : params;
    let prologue = '';
    const sig = list
      .map((p) => {
        this.scopes.set(p.name, p.type);
        if (p.def) prologue += `if (${mangle(p.name)} === undefined) ${mangle(p.name)} = ${this.expr(p.def)};\n`;
        return p.star === 'args' ? `...${mangle(p.name)}` : mangle(p.name);
      })
      .join(', ');
    return { sig, prologue, list };
  }

  private funcBody(fn: FuncDecl, isMethod: boolean, prologue: string, params: Param[]): string {
    let hoist = '';
    if (this.lang === 'py') {
      const names = new Set<string>();
      this.collectAssigned(fn.body, names);
      const globals = new Set<string>();
      this.collectGlobals(fn.body, globals);
      for (const p of params) names.delete(p.name);
      for (const g of globals) names.delete(g);
      for (const st of fn.body) if (st.k === 'func' || st.k === 'struct') names.delete(st.name);
      if (isMethod && fn.params[0]) names.delete(fn.params[0].name);
      if (names.size) hoist = `let ${[...names].map(mangle).join(', ')};\n`;
      if (isMethod && fn.params[0]) hoist += `const ${mangle(fn.params[0].name)} = this;\n`;
    }
    return `{\n${hoist}${prologue}${this.stmts(fn.body)}}`;
  }

  private funcDecl(fn: FuncDecl): string {
    this.scopes.push();
    const prevRet = this.retType;
    this.retType = fn.ret;
    this.funcDepth++;
    const { sig, prologue, list } = this.params(fn.params, false);
    const body = this.funcBody(fn, false, prologue, list);
    this.funcDepth--;
    this.retType = prevRet;
    this.scopes.pop();
    return `async function ${mangle(fn.name)}(${sig}) ${body}\n`;
  }

  private structDecl(st: StructDecl): string {
    const prevStruct = this.currentStruct;
    this.currentStruct = st;
    const base = st.base && this.structs.has(st.base) ? st.base : undefined;
    let out = `class ${mangle(st.name)}${base ? ` extends ${mangle(base)}` : ''} {\n`;
    // field initialisers
    out += `async __fi() {\n${base ? 'await super.__fi();\n' : ''}`;
    this.scopes.push();
    for (const f of st.fields) {
      const v = f.init ? this.init(f.init, f.type) : this.defaultValue(f.type);
      out += `this.${f.name} = ${v};\n`;
    }
    this.scopes.pop();
    out += '}\n';
    // constructors (C++): dispatch by argument count
    if (st.ctors.length) {
      out += 'async __init__(...a) {\nswitch (a.length) {\n';
      for (const c of st.ctors) {
        this.scopes.push();
        const names = c.params.map((p) => mangle(p.name));
        c.params.forEach((p) => this.scopes.set(p.name, p.type));
        const required = c.params.filter((p) => !p.def).length;
        for (let n = required; n <= c.params.length; n++) out += `case ${n}: `;
        out += '{\n';
        out += `const [${names.join(', ')}] = a;\n`;
        for (const p of c.params) if (p.def) out += `if (${mangle(p.name)} === undefined) ${mangle(p.name)} = ${this.expr(p.def)};\n`;
        for (const ci of c.ctorInit ?? []) {
          if (ci.field === st.base) out += `await super.__init__(${ci.args.map((x) => this.expr(x)).join(', ')});\n`;
          else {
            const ft = this.findField(st, ci.field)?.type;
            out += `this.${ci.field} = ${ci.args.length === 1 ? this.coerce(ft, ci.args[0], this.expr(ci.args[0])) : `await $.make(${q(ft?.name ?? '')}, [${ci.args.map((x) => this.expr(x)).join(', ')}])`};\n`;
          }
        }
        out += this.stmts(c.body);
        out += 'return; }\n';
        this.scopes.pop();
      }
      out += '}\n}\n';
    }
    // methods
    const isPy = this.lang === 'py';
    for (const m of st.methods) {
      this.scopes.push();
      const prevRet = this.retType;
      this.retType = m.ret;
      this.funcDepth++;
      const { sig, prologue, list } = this.params(m.params, isPy);
      const body = this.funcBody(m, isPy, prologue, list);
      this.funcDepth--;
      this.retType = prevRet;
      this.scopes.pop();
      out += `async ${m.name}(${sig}) ${body}\n`;
    }
    out += '}\n';
    const fields = this.allFields(st).map((f) => q(f.name)).join(', ');
    out += `${mangle(st.name)}.__fields = [${fields}];\n`;
    this.currentStruct = prevStruct;
    return out;
  }

  // ------------------------------------------------------------ expressions
  private cond(e: Expr): string {
    if (this.lang === 'py') {
      const plain = (x: Expr): boolean =>
        x.k === 'bool' ||
        (x.k === 'unary' && x.op === '!') ||
        (x.k === 'bin' && (CMP_OPS.has(x.op)) && (x.op !== '&&' && x.op !== '||' ? true : plain(x.l) && plain(x.r)));
      if (!plain(e)) return `$.truthy(${this.expr(e)})`;
    }
    return this.expr(e);
  }

  private ordIf(e: Expr, other: Expr): string {
    const js = this.expr(e);
    if (this.lang !== 'cpp') return js;
    if (this.isChar(e)) {
      const ot = this.inferType(other);
      if (this.isChar(other) || this.isInt(ot) || this.isFloat(ot) || ot?.name === 'bool') return `$.ord(${js})`;
    }
    return js;
  }

  private resolveId(name: string): string {
    const alias = this.scopes.get(name)?.alias;
    if (alias) return alias;
    if (this.lang === 'cpp' && !this.scopes.has(name) && this.currentStruct && this.findField(this.currentStruct, name)) {
      return `this.${name}`;
    }
    return mangle(name);
  }

  private isNumLit(e: Expr): boolean { return e.k === 'num'; }

  expr(e: Expr, stmtCtx = false): string {
    switch (e.k) {
      case 'num': return Number.isFinite(e.v) ? String(e.v) : '0';
      case 'str': return q(e.v);
      case 'char': return q(e.v);
      case 'bool': return e.v ? 'true' : 'false';
      case 'null': return 'null';
      case 'id': return e.name === 'this' ? 'this' : this.resolveId(e.name);
      case 'member': return `${this.expr(e.obj)}.${e.prop}`;
      case 'index':
        return this.lang === 'py' && !(e.idx.k === 'num' && e.idx.v >= 0)
          ? `$.at(${this.expr(e.obj)}, ${this.expr(e.idx)})`
          : `${this.expr(e.obj)}[${this.expr(e.idx)}]`;
      case 'slice':
        return `$.slice(${this.expr(e.obj)}, ${e.lo ? this.expr(e.lo) : 'undefined'}, ${e.hi ? this.expr(e.hi) : 'undefined'}, ${e.step ? this.expr(e.step) : 'undefined'})`;
      case 'call': return this.call(e);
      case 'unary': {
        if (e.op === '*' || e.op === '&') return this.expr(e.arg);
        if (e.op === '!' && this.lang === 'py') return `!${this.cond(e.arg)}`;
        return `(${e.op}${this.expr(e.arg)})`;
      }
      case 'update': {
        const a = this.expr(e.arg);
        return e.prefix ? `(${e.op}${a})` : `(${a}${e.op})`;
      }
      case 'bin': return this.binary(e);
      case 'assign': return this.assign(e, stmtCtx);
      case 'cond': return `(${this.cond(e.test)} ? ${this.expr(e.a)} : ${this.expr(e.b)})`;
      case 'lambda': return this.lambda(e);
      case 'list': return `[${e.items.map((i) => this.expr(i)).join(', ')}]`;
      case 'dict': return `$.dict([${e.entries.map(([k, v]) => `[${this.expr(k)}, ${this.expr(v)}]`).join(', ')}])`;
      case 'fstr': {
        let out = '`';
        for (const p of e.parts) {
          if (typeof p === 'string') out += p.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
          else if (p.spec || p.conv) out += `\${$.fmtv(${this.expr(p.e)}, ${q(p.spec ?? '')}, ${q(p.conv ?? '')})}`;
          else out += `\${$.str(${this.expr(p.e)})}`;
        }
        return out + '`';
      }
      case 'listcomp': {
        const v = e.vars.map(mangle);
        const head = e.vars.length === 1 ? `let ${v[0]}` : `const $c`;
        const unpack = e.vars.length === 1 ? '' : `let [${v.join(', ')}] = $.unpack($c);\n`;
        const test = e.cond ? `if (${this.cond(e.cond)}) ` : '';
        return `(await (async () => { const $r = [];\nfor (${head} of $.iter(${this.expr(e.iter)})) {\n${unpack}${test}$r.push(${this.expr(e.elt)}); }\nreturn $r; })())`;
      }
      case 'cast': return this.cast(e.type, e.arg);
    }
  }

  private cast(t: TypeRef, arg: Expr): string {
    const a = this.expr(arg);
    if (t.ptr) return a;
    if (this.isInt(t)) return `$.toint(${a})`;
    if (this.isFloat(t)) return `Number(${a})`;
    if (t.name === 'bool') return `!!${a}`;
    if (t.name === 'char') return `$.chr(${a})`;
    if (t.name === 'string') return `$.str(${a})`;
    return a;
  }

  private binary(e: Extract<Expr, { k: 'bin' }>): string {
    const { op, l, r } = e;
    if (op === ',') return `(${this.expr(l)}, ${this.expr(r)})`;
    if (op === '<<') return `$.shl(${this.expr(l)}, ${this.expr(r)})`;
    if (op === 'in') return `$.in(${this.expr(l)}, ${this.expr(r)})`;
    if (op === 'not in') return `!$.in(${this.expr(l)}, ${this.expr(r)})`;
    if (op === 'is') return `(${this.expr(l)} === ${this.expr(r)})`;
    if (op === 'is not') return `(${this.expr(l)} !== ${this.expr(r)})`;
    if (op === '&&' || op === '||') return `(${this.lang === 'py' ? this.exprForLogic(l) : this.expr(l)} ${op} ${this.lang === 'py' ? this.exprForLogic(r) : this.expr(r)})`;
    if (this.lang === 'py') {
      switch (op) {
        case '+': return this.isNumLit(l) || this.isNumLit(r) ? `(${this.expr(l)} + ${this.expr(r)})` : `$.padd(${this.expr(l)}, ${this.expr(r)})`;
        case '*': return `$.pmul(${this.expr(l)}, ${this.expr(r)})`;
        case '//': return `$.floordiv(${this.expr(l)}, ${this.expr(r)})`;
        case '%': return `$.pmod(${this.expr(l)}, ${this.expr(r)})`;
        case '/': return `$.truediv(${this.expr(l)}, ${this.expr(r)})`;
        case '==': return `$.eq(${this.expr(l)}, ${this.expr(r)})`;
        case '!=': return `!$.eq(${this.expr(l)}, ${this.expr(r)})`;
      }
    } else {
      const lt0 = this.inferType(l);
      const opName = OPERATOR_METHODS[op];
      if (opName) {
        // user-defined operator on a struct/class
        const m = this.findMethod(this.structOf(lt0), `op_${opName}`);
        if (m) return `(await ${this.expr(l)}.op_${opName}(${this.expr(r)}))`;
      }
      if (op === '+' && this.isCharPtr(lt0)) return `$.ptradd(${this.expr(l)}, ${this.expr(r)})`;
      if (op === '/') {
        const lt = lt0;
        const rt = this.inferType(r);
        if (this.isInt(lt) && this.isInt(rt)) return `$.idiv(${this.expr(l)}, ${this.expr(r)})`;
      }
      if (op === '==') return `(${this.ordIf(l, r)} === ${this.ordIf(r, l)})`;
      if (op === '!=') return `(${this.ordIf(l, r)} !== ${this.ordIf(r, l)})`;
      if (ARITH.has(op) || ['<', '>', '<=', '>='].includes(op)) {
        const wantOrd = op !== '+' || this.isChar(l) !== this.isChar(r);
        if (wantOrd) return `(${this.ordIf(l, r)} ${op} ${this.ordIf(r, l)})`;
      }
    }
    return `(${this.expr(l)} ${op} ${this.expr(r)})`;
  }

  private exprForLogic(e: Expr): string {
    return e.k === 'bin' && (e.op === '&&' || e.op === '||') ? this.expr(e) : this.expr(e);
  }

  private assign(e: Extract<Expr, { k: 'assign' }>, stmtCtx: boolean): string {
    const { op, target, value } = e;
    if (target.k === 'list') {
      // python tuple unpacking
      const names = target.items.map((i) => this.expr(i)).join(', ');
      return `[${names}] = $.unpack(${this.expr(value)})`;
    }
    const tgt = this.expr(target);
    const wrap = (s: string): string => (stmtCtx ? s : `(${s})`);
    const tt = this.inferType(target);
    if (op === '=') return wrap(`${tgt} = ${this.coerce(tt, value, this.expr(value))}`);
    const base = op.slice(0, -1);
    if (this.lang === 'py') {
      switch (base) {
        case '+': return wrap(`${tgt} = $.padd(${tgt}, ${this.expr(value)})`);
        case '*': return wrap(`${tgt} = $.pmul(${tgt}, ${this.expr(value)})`);
        case '//': return wrap(`${tgt} = $.floordiv(${tgt}, ${this.expr(value)})`);
        case '%': return wrap(`${tgt} = $.pmod(${tgt}, ${this.expr(value)})`);
        case '/': return wrap(`${tgt} = ${tgt} / ${this.expr(value)}`);
      }
    } else {
      if (base === '/' && this.isInt(tt) && this.isInt(this.inferType(value))) return wrap(`${tgt} = $.idiv(${tgt}, ${this.expr(value)})`);
      if (this.isInt(tt) && this.isFloat(this.inferType(value)) && base !== '') return wrap(`${tgt} = Math.trunc(${tgt} ${base} ${this.expr(value)})`);
    }
    return wrap(`${tgt} ${op} ${this.expr(value)}`);
  }

  private lambda(e: Extract<Expr, { k: 'lambda' }>): string {
    this.scopes.push();
    const { sig, prologue } = this.params(e.params, false);
    let out: string;
    if (Array.isArray(e.body)) {
      const names = new Set<string>();
      let hoist = '';
      if (this.lang === 'py') {
        this.collectAssigned(e.body, names);
        for (const p of e.params) names.delete(p.name);
        if (names.size) hoist = `let ${[...names].map(mangle).join(', ')};\n`;
      }
      out = `(async (${sig}) => {\n${hoist}${prologue}${this.stmts(e.body)}})`;
    } else if (containsCall(e.body) || prologue) {
      out = `(async (${sig}) => {\n${prologue}return ${this.expr(e.body)};\n})`;
    } else {
      out = `((${sig}) => ${this.expr(e.body)})`;
    }
    this.scopes.pop();
    return out;
  }

  private callArgs(args: Expr[]): string {
    return args.map((a) => this.expr(a)).join(', ');
  }

  private call(e: Extract<Expr, { k: 'call' }>): string {
    const { callee, args, kwargs } = e;
    const kw = (): string => (kwargs?.length ? `$.kw({${kwargs.map((k) => `${q(k.name)}: ${this.expr(k.value)}`).join(', ')}})` : '');
    const withKw = (): string => [this.callArgs(args), kw()].filter(Boolean).join(', ');

    if (callee.k === 'id') {
      const name = callee.name;
      const local = this.scopes.has(name);
      if (name === 'sizeof' && args.length === 1) return `$.sizeof(${this.expr(args[0])})`;
      if (name === 'waitUntil' && args.length === 1 && !local) return `(await $.waitUntil(async () => ${this.expr(args[0])}))`;
      if (name === 'swap' && args.length === 2 && !local) {
        const a = this.expr(args[0]);
        const b = this.expr(args[1]);
        return `([${a}, ${b}] = [${b}, ${a}])`;
      }
      if (this.structs.has(name) && !local) {
        const st = this.structs.get(name) as StructDecl;
        return `(await $.new(${mangle(name)}, [${this.structArgs(st, args, kwargs)}]))`;
      }
      const fn = this.funcs.get(name);
      if (fn && !local) return `(await ${mangle(name)}(${this.mapKwargs(fn, args, kwargs)}))`;
      if (this.lang === 'cpp' && this.currentStruct && !local && this.findMethod(this.currentStruct, name)) {
        return `(await this.${name}(${this.callArgs(args)}))`;
      }
      if (this.lang === 'cpp' && !local && ['int', 'long', 'short', 'unsigned', 'size_t'].includes(name) && args.length === 1) return `$.toint(${this.expr(args[0])})`;
      if (this.lang === 'cpp' && !local && (name === 'double' || name === 'float') && args.length === 1) return `Number(${this.expr(args[0])})`;
      if (this.lang === 'cpp' && !local && name === 'char' && args.length === 1) return `$.chr(${this.expr(args[0])})`;
      return `(await ${this.resolveId(name)}(${withKw()}))`;
    }

    if (callee.k === 'member') {
      const { obj, prop } = callee;
      // super().method(...)
      if (obj.k === 'call' && obj.callee.k === 'id' && obj.callee.name === 'super') return `(await super.${prop}(${this.callArgs(args)}))`;
      if (args.length === 0 && (prop === 'length' || prop === 'size') && this.lang === 'cpp') return `$.size(${this.expr(obj)})`;
      if (args.length === 0 && (prop === 'begin' || prop === 'end' || prop === 'c_str' || prop === 'data')) return this.expr(obj);
      if (this.lang === 'py' && prop === 'replace' && args.length === 2) return `${this.expr(obj)}.replaceAll(${this.callArgs(args)})`;
      if (this.lang === 'py' && (prop === 'pop' || prop === 'sort' || prop === 'split')) {
        const helper = prop === 'pop' ? 'pypop' : prop === 'sort' ? 'pysort' : 'pysplit';
        return `(await $.${helper}(${[this.expr(obj), withKw()].filter(Boolean).join(', ')}))`;
      }
      const st = this.structOf(this.inferType(obj)) ?? (obj.k === 'id' && obj.name === 'this' ? this.currentStruct : undefined);
      const m = this.findMethod(st, prop);
      if (m && kwargs?.length) return `(await ${this.expr(obj)}.${prop}(${this.mapKwargs(m, args, kwargs, this.lang === 'py' ? 1 : 0)}))`;
      return `(await ${this.expr(obj)}.${prop}(${withKw()}))`;
    }
    return `(await (${this.expr(callee)})(${withKw()}))`;
  }

  /** Reorder python keyword arguments into positional slots for a known user function. */
  private mapKwargs(fn: FuncDecl, args: Expr[], kwargs?: { name: string; value: Expr }[], skip = 0): string {
    const pos = args.map((a) => this.expr(a));
    if (!kwargs?.length) return pos.join(', ');
    const params = fn.params.slice(skip);
    const slots = [...pos];
    const extra: string[] = [];
    let kwParam = -1;
    params.forEach((p, i) => { if (p.star === 'kwargs') kwParam = i; });
    for (const k of kwargs) {
      const idx = params.findIndex((p) => p.name === k.name && !p.star);
      if (idx >= 0) slots[idx] = this.expr(k.value);
      else extra.push(`${q(k.name)}: ${this.expr(k.value)}`);
    }
    if (kwParam >= 0) slots[kwParam] = `$.dict(Object.entries({${extra.join(', ')}}))`;
    for (let i = 0; i < slots.length; i++) if (slots[i] === undefined) slots[i] = 'undefined';
    return slots.join(', ');
  }

  private structArgs(st: StructDecl, args: Expr[], kwargs?: { name: string; value: Expr }[]): string {
    const init = this.findMethod(st, '__init__') ?? st.ctors[0];
    if (kwargs?.length && init) return this.mapKwargs(init, args, kwargs, this.lang === 'py' ? 1 : 0);
    const fields = this.allFields(st);
    return args.map((a, i) => (a.k === 'list' ? this.init(a, fields[i]?.type) : this.expr(a))).join(', ');
  }
}

export function generate(prog: Program, globalNames: string[], entry?: string): string {
  try {
    return new Codegen(prog).generate(globalNames, entry);
  } catch (e) {
    if (e instanceof SyntaxErr) throw e;
    throw e;
  }
}
