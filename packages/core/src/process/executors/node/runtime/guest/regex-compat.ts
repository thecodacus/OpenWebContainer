/**
 * Guest-side source compatibility. Plain JavaScript inside String.raw, prepended to
 * LOADER_SRC. A CommonJS module is rewritten only after QuickJS rejects the whole module that
 * Node accepts (see compileCjsWrapper in loader.ts), so one that compiles today is never
 * rewritten. An ES module cannot be recompiled after it fails, so the host asks for its rewrite
 * through api.compatRewrite and uses it only when it changes the source and a test compile shows
 * the engine rejects the source as it is (esmSource in process.ts).
 * Two rewrites, each exact in meaning:
 *  - a regex literal the engine rejects gets each identity hyphen escape replaced by the hex
 *    escape of the same character (QuickJS rejects backslash-minus inside a class under the u
 *    flag; a hex escape is an atom, never a range operator);
 *  - a class element named get, set or async and followed by a semicolon is written as the quoted
 *    name, declaring the same field (QuickJS parses the bare form as an accessor and fails with
 *    "invalid property name").
 * The scanner tracks strings, template literals, comments, regex literals (previous-token rule)
 * and class bodies, so only real literals and class elements are touched.
 */
export const REGEX_COMPAT_SRC = String.raw`
var RX_NATIVE_REGEXP = RegExp;
var RX_REGEX_AFTER_WORD ={ 'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1, 'void': 1, 'throw': 1, 'case': 1, 'do': 1, 'else': 1, 'yield': 1, 'await': 1 };
var RX_VALUE_WORD = { 'this': 1, 'super': 1, 'null': 1, 'true': 1, 'false': 1 };
var RX_ELEMENT_NAME = { 'get': 1, 'set': 1, 'async': 1 };
function rxIsSpace(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function rxIsNewline(c) { return c === 10 || c === 13 || c === 0x2028 || c === 0x2029; }
function rxIsIdStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || (c > 127 && !rxIsSpace(c));
}
function rxIsIdPart(c) { return rxIsIdStart(c) || (c >= 48 && c <= 57); }
function rxSkip(src, i, st) {
  var n = src.length;
  while (i < n) {
    var c = src.charCodeAt(i);
    if (rxIsSpace(c)) {
      if (rxIsNewline(c)) st.nl = true;
      i++;
      continue;
    }
    if (c === 47) {
      var d = src.charCodeAt(i + 1);
      if (d === 47) {
        i += 2;
        while (i < n && !rxIsNewline(src.charCodeAt(i))) i++;
        continue;
      }
      if (d === 42) {
        var end = src.indexOf('*/', i + 2);
        if (end < 0) return n;
        for (var k = i; k < end; k++) if (rxIsNewline(src.charCodeAt(k))) st.nl = true;
        i = end + 2;
        continue;
      }
    }
    return i;
  }
  return i;
}
function rxTemplateText(src, i) {
  var n = src.length;
  while (i < n) {
    var c = src.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c === 96) return { next: i + 1, sub: false };
    if (c === 36 && src.charCodeAt(i + 1) === 123) return { next: i + 2, sub: true };
    i++;
  }
  return { next: n, sub: false };
}
function rxReadRegex(src, start) {
  var n = src.length, i = start + 1, inClass = false;
  while (i < n) {
    var c = src.charCodeAt(i);
    if (rxIsNewline(c)) return null;
    if (c === 92) { i += 2; continue; }
    if (inClass) { if (c === 93) inClass = false; }
    else if (c === 91) inClass = true;
    else if (c === 47) break;
    i++;
  }
  if (i >= n) return null;
  var flagEnd = i + 1;
  while (flagEnd < n && rxIsIdPart(src.charCodeAt(flagEnd))) flagEnd++;
  return { s: start, e: flagEnd, body: src.slice(start + 1, i), flags: src.slice(i + 1, flagEnd) };
}
function rxRegexAllowed(last) {
  if (last === null || last.k === 'kw') return true;
  if (last.k === 'p') return last.v !== ')' && last.v !== ']';
  return false;
}
function rxScan(src) {
  var n = src.length, i = 0, st = { nl: false }, look = { nl: false };
  var stack = [], regexes = [], names = [];
  var last = null, classHead = -1;
  while (i < n) {
    i = rxSkip(src, i, st);
    if (i >= n) break;
    var nl = st.nl;
    st.nl = false;
    var c = src.charCodeAt(i);
    if (rxIsIdStart(c) || c === 92) {
      var j = i + 1;
      while (j < n) {
        var d = src.charCodeAt(j);
        if (rxIsIdPart(d)) j++;
        else if (d === 92) j += 2;
        else break;
      }
      var word = src.slice(i, j);
      var afterDot = last !== null && last.k === 'p' && (last.v === '.' || last.v === '?.');
      if (word === 'class' && !afterDot) {
        var nx = rxSkip(src, j, look);
        if (nx < n && (rxIsIdStart(src.charCodeAt(nx)) || src.charCodeAt(nx) === 123)) classHead = stack.length;
      }
      if (!afterDot && RX_ELEMENT_NAME.hasOwnProperty(word) && stack.length > 0 && stack[stack.length - 1] === 'C') {
        var starts = last !== null && ((last.k === 'p' && (last.v === '{' || last.v === ';' || last.v === '}')) ||
          (last.k === 'id' && last.v === 'static') ||
          (nl && (last.k === 'val' || last.k === 'id' || (last.k === 'p' && (last.v === ')' || last.v === ']')))));
        if (starts) {
          var semi = rxSkip(src, j, look);
          if (semi < n && src.charCodeAt(semi) === 59) names.push({ s: i, e: j, text: '"' + word + '"' });
        }
      }
      if (!afterDot && RX_REGEX_AFTER_WORD.hasOwnProperty(word)) last = { k: 'kw', v: word };
      else if (afterDot || RX_VALUE_WORD.hasOwnProperty(word)) last = { k: 'val', v: word };
      else last = { k: 'id', v: word };
      i = j;
      continue;
    }
    if ((c >= 48 && c <= 57) || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      var k2 = i + 1;
      while (k2 < n && (rxIsIdPart(src.charCodeAt(k2)) || src.charCodeAt(k2) === 46)) k2++;
      last = { k: 'val', v: '' };
      i = k2;
      continue;
    }
    if (c === 34 || c === 39) {
      var k3 = i + 1;
      while (k3 < n) {
        var e3 = src.charCodeAt(k3);
        if (e3 === 92) { k3 += src.charCodeAt(k3 + 1) === 13 && src.charCodeAt(k3 + 2) === 10 ? 3 : 2; continue; }
        if (e3 === c || rxIsNewline(e3)) break;
        k3++;
      }
      last = { k: 'val', v: '' };
      i = k3 < n && src.charCodeAt(k3) === c ? k3 + 1 : k3;
      continue;
    }
    if (c === 96) {
      var t1 = rxTemplateText(src, i + 1);
      last = t1.sub ? { k: 'p', v: 'tsub' } : { k: 'val', v: '' };
      if (t1.sub) stack.push('T');
      i = t1.next;
      continue;
    }
    if (c === 47) {
      var re = rxRegexAllowed(last) ? rxReadRegex(src, i) : null;
      if (re !== null) {
        regexes.push(re);
        last = { k: 'val', v: '' };
        i = re.e;
        continue;
      }
      last = { k: 'p', v: '/' };
      i += src.charCodeAt(i + 1) === 61 ? 2 : 1;
      continue;
    }
    if (c === 40 || c === 91) {
      stack.push(c === 40 ? 'P' : 'A');
      last = { k: 'p', v: c === 40 ? '(' : '[' };
      i++;
      continue;
    }
    if (c === 123) {
      if (classHead === stack.length) { stack.push('C'); classHead = -1; }
      else stack.push('B');
      last = { k: 'p', v: '{' };
      i++;
      continue;
    }
    if (c === 125) {
      if (stack.length > 0 && stack[stack.length - 1] === 'T') {
        stack.pop();
        var t2 = rxTemplateText(src, i + 1);
        last = t2.sub ? { k: 'p', v: 'tsub' } : { k: 'val', v: '' };
        if (t2.sub) stack.push('T');
        i = t2.next;
        continue;
      }
      stack.pop();
      last = { k: 'p', v: '}' };
      i++;
      continue;
    }
    if (c === 41 || c === 93) {
      stack.pop();
      last = { k: 'p', v: c === 41 ? ')' : ']' };
      i++;
      continue;
    }
    if ((c === 43 || c === 45) && src.charCodeAt(i + 1) === c) {
      last = { k: 'val', v: '' };
      i += 2;
      continue;
    }
    if (c === 63 && src.charCodeAt(i + 1) === 46 && !(src.charCodeAt(i + 2) >= 48 && src.charCodeAt(i + 2) <= 57)) {
      last = { k: 'p', v: '.' };
      i += 2;
      continue;
    }
    if (c === 46) {
      i += src.charCodeAt(i + 1) === 46 && src.charCodeAt(i + 2) === 46 ? 3 : 1;
      last = { k: 'p', v: '.' };
      continue;
    }
    if (c === 61 && src.charCodeAt(i + 1) === 62) {
      last = { k: 'p', v: '=>' };
      i += 2;
      continue;
    }
    last = { k: 'p', v: String.fromCharCode(c) };
    i++;
  }
  return { regexes: regexes, names: names };
}
function rxCompiles(body, flags) {
  try { new RX_NATIVE_REGEXP(body, flags); return true; } catch (e) { return false; }
}
function rxFixBody(body) {
  var out = '';
  var n = body.length;
  for (var k = 0; k < n; k++) {
    var ch = body.charAt(k);
    if (ch === '\\' && k + 1 < n) {
      var nx = body.charAt(k + 1);
      out += nx === '-' ? '\\x2d' : ch + nx;
      k++;
    } else {
      out += ch;
    }
  }
  return out;
}
function rxRewrite(src) {
  var scan = rxScan(src);
  var edits = [];
  for (var k = 0; k < scan.regexes.length; k++) {
    var re = scan.regexes[k];
    if (rxCompiles(re.body, re.flags)) continue;
    var fixed = rxFixBody(re.body);
    if (fixed !== re.body && rxCompiles(fixed, re.flags)) edits.push({ s: re.s, e: re.e, text: '/' + fixed + '/' + re.flags });
  }
  for (var m = 0; m < scan.names.length; m++) edits.push(scan.names[m]);
  if (edits.length === 0) return null;
  edits.sort(function (a, b) { return a.s - b.s; });
  var out = '', at = 0;
  for (var q = 0; q < edits.length; q++) {
    out += src.slice(at, edits[q].s) + edits[q].text;
    at = edits[q].e;
  }
  return out + src.slice(at);
}
/* Runtime RegExp: a pattern built with new RegExp (for example camelcase joining a class that has \- with a u flag) gets the same \- fix as a literal. The wrapper only retries a u-flag SyntaxError and otherwise keeps the native constructor's behaviour: same prototype, same statics. */
(function () {
  var NativeRegExp = RegExp;
  function CompatRegExp(pattern, flags) {
    var target = new.target || CompatRegExp;
    try {
      return Reflect.construct(NativeRegExp, [pattern, flags], target);
    } catch (error) {
      var unicode = typeof flags === 'string' && flags.indexOf('u') >= 0;
      if (!(error instanceof SyntaxError) || !unicode) throw error;
      var source = pattern instanceof NativeRegExp ? pattern.source : String(pattern);
      var fixed = rxFixBody(source);
      if (fixed === source) throw error;
      return Reflect.construct(NativeRegExp, [fixed, flags], target);
    }
  }
  CompatRegExp.prototype = NativeRegExp.prototype;
  Reflect.ownKeys(NativeRegExp).forEach(function (key) {
    if (key === 'length' || key === 'name' || key === 'prototype') return;
    Object.defineProperty(CompatRegExp, key, Object.getOwnPropertyDescriptor(NativeRegExp, key));
  });
  Object.defineProperty(CompatRegExp, 'name', { value: 'RegExp', configurable: true });
  Object.defineProperty(NativeRegExp.prototype, 'constructor', { value: CompatRegExp, writable: true, configurable: true });
  globalThis.RegExp = CompatRegExp;
})();
`;
