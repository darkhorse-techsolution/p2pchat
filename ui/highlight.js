'use strict';
// Small syntax highlighter. No dependency, no network. Covers the shapes that
// matter in chat snippets: comments, strings, numbers, keywords, calls, types.
(() => {
  const KW = new Set(('abstract as assert async await break case catch class const continue def default del delete do elif else enum except export extends ' +
    'final finally fn for from func function global go if impl implements import in instanceof interface is lambda let loop match mod module mut namespace new nonlocal ' +
    'not of or and package pass private protected public pub raise return select static struct super switch this throw throws trait try type typeof unsafe use var void ' +
    'where while with yield SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE JOIN LEFT RIGHT INNER ON GROUP BY ORDER LIMIT CREATE TABLE ALTER DROP INDEX AND OR NOT NULL AS ' +
    'echo exit export local readonly then fi done esac elif function source').split(' '));
  const LIT = new Set('true false null undefined None True False nil NaN Infinity self'.split(' '));
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function detect(code) {
    const c = code.slice(0, 2000);
    if (/^\s*#!\s*\/.*\b(ba|z)?sh\b/.test(c) || /^\s*(echo|export|cd|ls|grep|curl|npm|git|sudo)\s/m.test(c)) return 'sh';
    if (/^\s*(def |class \w+(\(.*\))?:|import \w+|from \w+ import|print\()/m.test(c)) return 'py';
    if (/\b(fn|let mut|impl|pub fn|use std::)\b/.test(c)) return 'rs';
    if (/^\s*(package \w+|func \w+\(|import \()/m.test(c)) return 'go';
    if (/^\s*(#include|int main\(|std::)/m.test(c)) return 'c';
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE)\b/im.test(c)) return 'sql';
    if (/^\s*</.test(c) && /<\/\w+>|\/>/.test(c)) return 'html';
    if (/^\s*[\[{]/.test(c) && /"\w+"\s*:/.test(c)) return 'json';
    if (/^\s*[.#@:\w-]+\s*\{[^}]*:[^}]*\}/m.test(c)) return 'css';
    if (/\b(interface|type \w+ =|: (string|number|boolean)\b)/.test(c)) return 'ts';
    return 'js';
  }

  const TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|--[^\n]*|<!--[\s\S]*?-->)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([{}()[\];,.])|([=+\-*/%<>!&|^~?:@]+)/g;

  function highlight(code, lang) {
    lang = lang || detect(code);
    const hashComments = /^(py|sh|rb|yaml|toml|ini)$/.test(lang);
    const slashComments = !/^(py|sh|rb|sql|yaml|toml|html|css|ini)$/.test(lang);
    let out = '', last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(code))) {
      out += esc(code.slice(last, m.index)); last = TOKEN.lastIndex;
      const [t, com, str, num, call, id, punc, op] = m;
      if (com) {
        const isHash = t.startsWith('#'), isSlash = t.startsWith('//') || t.startsWith('/*'), isDash = t.startsWith('--');
        const real = (isHash && hashComments) || (isSlash && slashComments) || (isDash && lang === 'sql') || t.startsWith('<!--');
        if (real) { out += `<span class="tk-c">${esc(t)}</span>`; continue; }
        // not a comment in this language: re-scan the first char as an operator and continue after it
        out += esc(t[0]); TOKEN.lastIndex = m.index + 1; last = TOKEN.lastIndex; continue;
      }
      if (str) out += `<span class="tk-s">${esc(t)}</span>`;
      else if (num) out += `<span class="tk-n">${t}</span>`;
      else if (call) out += KW.has(call) ? `<span class="tk-k">${call}</span>` : `<span class="tk-f">${call}</span>`;
      else if (id) out += KW.has(id) ? `<span class="tk-k">${id}</span>` : LIT.has(id) ? `<span class="tk-l">${id}</span>` : /^[A-Z][\w]*$/.test(id) && id.length > 1 ? `<span class="tk-t">${id}</span>` : id;
      else if (punc) out += `<span class="tk-p">${esc(t)}</span>`;
      else if (op) out += `<span class="tk-o">${esc(t)}</span>`;
      else out += esc(t);
    }
    return { html: out + esc(code.slice(last)), lang };
  }

  window.hl = { highlight, detect, esc };
})();
