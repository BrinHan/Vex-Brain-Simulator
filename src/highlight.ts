import type { Lang } from './lang/compile';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, s: string): string => `<span class="${cls}">${esc(s)}</span>`;
const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const CPP_CTL = words('if else for while do switch case default break continue return goto try catch throw');
const CPP_KW = words(
  'struct class enum union namespace using typedef template typename static const constexpr volatile extern inline virtual explicit ' +
  'public private protected operator new delete this sizeof auto register mutable friend final override noexcept true false nullptr NULL static_assert',
);
const CPP_TYPES = words(
  'int long short unsigned signed char bool float double void size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t string vector map ' +
  'array pair brain controller motor motor_group inertial competition digital_out digital_in thread task timer mutex color fontType',
);
const VEX_API = words('Brain Screen Timer Battery SDcard Controller1 Competition wait msec seconds sec timeUnits printf vex std');

const PY_CTL = words('if elif else for while break continue return try except finally raise with pass yield');
const PY_KW = words('def class import from as lambda global nonlocal and or not in is del assert async await True False None');
const PY_BUILTINS = words('print len range int float str bool list dict tuple set abs min max sum round sorted enumerate zip map filter any all chr ord isinstance super');
const PY_VEX = words('brain Brain Color FontType wait MSEC SECONDS Thread Controller Motor Competition');

const CPP_RE = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(^[ \t]*#[^\n]*)|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(\b0[xX][0-9a-fA-F]+\b|\b\d+\.?\d*(?:[eE][+-]?\d+)?[fFuUlL]*\b)|([A-Za-z_]\w*)|([\s\S])/gm;
const PY_RE = /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|[fFrRbB]{0,2}"(?:\\.|[^"\\\n])*"?|[fFrRbB]{0,2}'(?:\\.|[^'\\\n])*'?)|(^[ \t]*@\w+)|(\b0[xX][0-9a-fA-F]+\b|\b\d+\.?\d*(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)|([\s\S])/gm;

/** Returns HTML (escaped, wrapped in colour spans) for the source; same characters, so it overlays a textarea exactly. */
export function highlight(code: string, lang: Lang): string {
  let out = '';
  let prevWord = '';
  const re = new RegExp(lang === 'cpp' ? CPP_RE : PY_RE);
  const cpp = lang === 'cpp';
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const [text, g1, g2, g3, g4, g5] = m;
    if (text === '') { re.lastIndex++; continue; }
    if (g1 !== undefined) out += span('t-com', text);
    // c++ groups: 2 = preprocessor, 3 = string. python groups: 2 = string, 3 = decorator
    else if (g2 !== undefined) out += span(cpp ? 't-pre' : 't-str', text);
    else if (g3 !== undefined) out += span(cpp ? 't-str' : 't-pre', text);
    else if (g4 !== undefined) out += span('t-num', text);
    else if (g5 !== undefined) {
      const next = code[re.lastIndex];
      let cls = '';
      if (cpp) {
        if (CPP_CTL.has(text)) cls = 't-ctl';
        else if (CPP_KW.has(text)) cls = 't-kw';
        else if (CPP_TYPES.has(text)) cls = 't-type';
        else if (VEX_API.has(text)) cls = 't-vex';
        else if (prevWord === 'struct' || prevWord === 'class' || prevWord === 'enum') cls = 't-type';
        else if (next === '(') cls = 't-fn';
      } else {
        if (PY_CTL.has(text)) cls = 't-ctl';
        else if (PY_KW.has(text)) cls = 't-kw';
        else if (prevWord === 'def' || (next === '(' && !PY_BUILTINS.has(text))) cls = prevWord === 'class' ? 't-type' : 't-fn';
        else if (prevWord === 'class') cls = 't-type';
        else if (PY_BUILTINS.has(text)) cls = 't-bi';
        else if (PY_VEX.has(text)) cls = 't-vex';
      }
      out += cls ? span(cls, text) : esc(text);
      prevWord = text;
    } else {
      out += esc(text);
      if (!/\s/.test(text)) prevWord = '';
    }
  }
  return out;
}
