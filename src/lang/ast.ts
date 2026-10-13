// Shared AST produced by both the C++ and Python front-ends and consumed by codegen.

export interface TypeRef {
  name: string; // normalised base name: int, double, string, bool, char, vector, <struct name>, ...
  args?: TypeRef[]; // template arguments (vector<int>)
  ref?: boolean;
  ptr?: boolean;
  dims?: (Expr | null)[]; // array dimensions: int a[3] / int a[]
  isStatic?: boolean; // `static` local variables keep their value between calls
  alias?: string; // codegen: hoisted JS name of a static local
}

export interface Param {
  name: string;
  type?: TypeRef;
  def?: Expr;
  star?: 'args' | 'kwargs';
}

export type Expr =
  | { k: 'num'; v: number; int: boolean }
  | { k: 'str'; v: string }
  | { k: 'char'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: Expr; prop: string }
  | { k: 'index'; obj: Expr; idx: Expr }
  | { k: 'slice'; obj: Expr; lo?: Expr; hi?: Expr; step?: Expr }
  | { k: 'call'; callee: Expr; args: Expr[]; kwargs?: { name: string; value: Expr }[] }
  | { k: 'unary'; op: string; arg: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'assign'; op: string; target: Expr; value: Expr }
  | { k: 'cond'; test: Expr; a: Expr; b: Expr }
  | { k: 'lambda'; params: Param[]; body: Expr | Stmt[] }
  | { k: 'list'; items: Expr[]; tuple?: boolean }
  | { k: 'dict'; entries: [Expr, Expr][] }
  | { k: 'update'; op: '++' | '--'; prefix: boolean; arg: Expr }
  | { k: 'fstr'; parts: (string | { e: Expr; spec?: string; conv?: string })[] }
  | { k: 'listcomp'; elt: Expr; vars: string[]; iter: Expr; cond?: Expr }
  | { k: 'cast'; type: TypeRef; arg: Expr };

export interface FuncDecl {
  k: 'func';
  name: string;
  params: Param[];
  ret?: TypeRef;
  body: Stmt[];
  isCtor?: boolean;
  ctorInit?: { field: string; args: Expr[] }[];
}

export interface FieldDecl {
  type?: TypeRef;
  name: string;
  init?: Expr;
}

export interface StructDecl {
  k: 'struct';
  name: string;
  base?: string;
  fields: FieldDecl[];
  methods: FuncDecl[];
  ctors: FuncDecl[];
}

/** `line` is the 1-based source line a statement starts on, used to point runtime errors at the user's code. */
export type Stmt = StmtBody & { line?: number };

type StmtBody =
  | { k: 'var'; type?: TypeRef; name: string; init?: Expr; ctorArgs?: Expr[] }
  | { k: 'expr'; e: Expr }
  | { k: 'if'; test: Expr; then: Stmt[]; else?: Stmt[] }
  | { k: 'while'; test: Expr; body: Stmt[] }
  | { k: 'dowhile'; test: Expr; body: Stmt[] }
  | { k: 'for'; init?: Stmt; test?: Expr; update?: Expr; body: Stmt[] }
  | { k: 'forin'; vars: string[]; type?: TypeRef; iter: Expr; body: Stmt[] }
  | { k: 'return'; e?: Expr }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'block'; body: Stmt[] }
  | { k: 'multi'; decls: Stmt[] }
  | FuncDecl
  | StructDecl
  | { k: 'enum'; name: string; members: { name: string; value?: Expr }[] }
  | { k: 'switch'; disc: Expr; cases: { test?: Expr; body: Stmt[] }[] }
  | { k: 'global'; names: string[] }
  | { k: 'throw'; e?: Expr }
  | { k: 'try'; body: Stmt[]; catchVar?: string; handler?: Stmt[]; fin?: Stmt[] }
  | { k: 'pass' };

export interface Program {
  lang: 'cpp' | 'py';
  body: Stmt[];
}

export class SyntaxErr extends Error {
  constructor(
    msg: string,
    public line: number,
  ) {
    super(msg);
  }
}
