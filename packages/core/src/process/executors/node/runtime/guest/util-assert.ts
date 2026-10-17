/**
 * Guest-side `util` (format/inspect with Node-style output, TextEncoder/TextDecoder)
 * and `assert` built-ins. Plain JavaScript inside a String.raw snippet.
 */
export const UTIL_ASSERT_SRC = String.raw`
function isIdentifierKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
}

function quoteStringLiteral(s) {
  var escaped = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  if (s.indexOf("'") >= 0 && s.indexOf('"') < 0) return '"' + escaped + '"';
  return "'" + escaped.replace(/'/g, "\\'") + "'";
}

function formatErrorStack(err) {
  var header = String(err.name || 'Error') + (err.message ? ': ' + err.message : '');
  var stack = err.stack ? String(err.stack) : '';
  if (stack.indexOf(header) === 0) return stack;
  return stack ? header + '\n' + stack : header;
}

function hexByte(b) {
  return (b < 16 ? '0' : '') + b.toString(16);
}

function constructorNameOf(obj) {
  var proto = Object.getPrototypeOf(obj);
  if (proto === null) return null;
  var ctor = proto.constructor;
  return ctor && ctor.name ? ctor.name : '';
}

function inspectValue(value, opts) {
  var maxDepth = opts && typeof opts.depth === 'number' ? opts.depth : 2;
  var stack = [];

  function fmt(v, depth, indent) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'string') return quoteStringLiteral(v);
    if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'boolean' || t === 'undefined' || t === 'symbol') return String(v);
    if (t === 'function') {
      var name = v.name ? v.name : '';
      if (/^class[\s{]/.test(Function.prototype.toString.call(v))) return '[class ' + (name || '(anonymous)') + ']';
      return '[Function: ' + (name || '(anonymous)') + ']';
    }
    if (stack.indexOf(v) >= 0) return '[Circular *1]';
    if (v instanceof Error) return formatErrorStack(v);
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise { <pending> }';

    var ctor = constructorNameOf(v);
    if (ctor === 'Buffer') {
      var shown = [];
      for (var b = 0; b < v.length && b < 50; b++) shown.push(hexByte(v[b]));
      var more = v.length > 50 ? ' ... ' + (v.length - 50) + ' more bytes' : '';
      return '<Buffer' + (shown.length ? ' ' + shown.join(' ') : '') + more + '>';
    }

    var isArr = Array.isArray(v);
    var isTyped = !isArr && ArrayBuffer.isView(v) && !(v instanceof DataView);
    if (depth > maxDepth) {
      if (isArr) return '[Array]';
      return '[' + (ctor === null ? 'Object: null prototype' : (ctor || 'Object')) + ']';
    }

    stack.push(v);
    var entries = [];
    var open = '{';
    var close = '}';
    var prefix = '';
    var i;
    if (isArr) {
      open = '[';
      close = ']';
      if (ctor && ctor !== 'Array') prefix = ctor + '(' + v.length + ') ';
      var limit = Math.min(v.length, 100);
      for (i = 0; i < limit; i++) entries.push(fmt(v[i], depth + 1, indent + 2));
      if (v.length > 100) entries.push('... ' + (v.length - 100) + ' more item' + (v.length - 100 > 1 ? 's' : ''));
    } else if (isTyped) {
      open = '[';
      close = ']';
      prefix = ctor + '(' + v.length + ') ';
      for (i = 0; i < v.length && i < 100; i++) entries.push(String(v[i]));
    } else if (v instanceof Map) {
      prefix = 'Map(' + v.size + ') ';
      v.forEach(function (val, key) {
        entries.push(fmt(key, depth + 1, indent + 2) + ' => ' + fmt(val, depth + 1, indent + 2));
      });
    } else if (v instanceof Set) {
      prefix = 'Set(' + v.size + ') ';
      v.forEach(function (val) {
        entries.push(fmt(val, depth + 1, indent + 2));
      });
    } else {
      if (ctor === null) prefix = '[Object: null prototype] ';
      else if (ctor && ctor !== 'Object') prefix = ctor + ' ';
    }

    var keys = Object.keys(v);
    for (var k = 0; k < keys.length; k++) {
      if (isArr && /^\d+$/.test(keys[k])) continue;
      if (isTyped && /^\d+$/.test(keys[k])) continue;
      var keyText = isIdentifierKey(keys[k]) ? keys[k] : quoteStringLiteral(keys[k]);
      entries.push(keyText + ': ' + fmt(v[keys[k]], depth + 1, indent + 2));
    }
    stack.pop();

    if (entries.length === 0) return prefix + open + close;
    var multiline = false;
    for (var e = 0; e < entries.length; e++) {
      if (entries[e].indexOf('\n') >= 0) multiline = true;
    }
    var start = entries.length + indent + open.length + prefix.length + 10;
    var totalLength = entries.length + start;
    var fits = !multiline && totalLength + entries.length <= 80;
    for (var s = 0; fits && s < entries.length; s++) {
      totalLength += entries[s].length;
      if (totalLength > 80) fits = false;
    }
    if (fits) return prefix + open + ' ' + entries.join(', ') + ' ' + close;
    var pad = ' '.repeat(indent + 2);
    return prefix + open + '\n' + entries.map(function (entry) { return pad + entry; }).join(',\n') + '\n' + ' '.repeat(indent) + close;
  }

  return fmt(value, 0, 0);
}

function formatLogArgs(args) {
  var out = [];
  var start = 0;
  var first = args[0];
  if (typeof first === 'string' && args.length > 1 && first.indexOf('%') >= 0) {
    var text = '';
    var argIndex = 1;
    for (var j = 0; j < first.length; j++) {
      var ch = first.charAt(j);
      if (ch === '%' && j + 1 < first.length) {
        var spec = first.charAt(j + 1);
        if (spec === '%') {
          text += '%';
          j++;
          continue;
        }
        if (argIndex < args.length && 'sdifjoOc'.indexOf(spec) >= 0) {
          var a = args[argIndex++];
          j++;
          if (spec === 's') text += typeof a === 'string' ? a : (typeof a === 'object' && a !== null ? inspectValue(a, { depth: 1 }) : String(a));
          else if (spec === 'd' || spec === 'i') text += String(spec === 'i' ? parseInt(a, 10) : Number(a));
          else if (spec === 'f') text += String(parseFloat(a));
          else if (spec === 'j') text += JSON.stringify(a);
          else if (spec === 'o' || spec === 'O') text += inspectValue(a);
          continue;
        }
      }
      text += ch;
    }
    out.push(text);
    start = argIndex;
  }
  for (var i = start; i < args.length; i++) {
    out.push(typeof args[i] === 'string' ? args[i] : inspectValue(args[i]));
  }
  return out.join(' ');
}

function deepEqualValues(a, b, strict) {
  if (strict ? Object.is(a, b) : (a == b || (a !== a && b !== b))) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (a instanceof Error && b instanceof Error) {
    if (a.message !== b.message || a.name !== b.name) return false;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    var mapOk = true;
    a.forEach(function (val, key) {
      if (!b.has(key) || !deepEqualValues(val, b.get(key), strict)) mapOk = false;
    });
    return mapOk;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    var setOk = true;
    a.forEach(function (val) {
      if (b.has(val)) return;
      var found = false;
      b.forEach(function (other) {
        if (!found && deepEqualValues(val, other, strict)) found = true;
      });
      if (!found) setOk = false;
    });
    return setOk;
  }
  var ka = Object.keys(a);
  var kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
    if (!deepEqualValues(a[ka[i]], b[ka[i]], strict)) return false;
  }
  return true;
}

function TextEncoderImpl() {
  this.encoding = 'utf-8';
}
TextEncoderImpl.prototype.encode = function (input) {
  return encodeUtf8(input === undefined ? '' : String(input));
};

function TextDecoderImpl(label) {
  this.encoding = String(label || 'utf-8').toLowerCase();
}
TextDecoderImpl.prototype.decode = function (input) {
  if (input === undefined) return '';
  var bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  return decodeBytes(bytes, this.encoding === 'utf-8' ? 'utf8' : this.encoding);
};

function utilArgError(code, message) {
  var err = new TypeError(message);
  err.code = code;
  return err;
}

function utilGetterOf(proto, name) {
  var desc = Object.getOwnPropertyDescriptor(proto, name);
  return desc && typeof desc.get === 'function' ? desc.get : null;
}

/* a brand check: the method or getter accepts the value only when it carries the matching internal slot */
function utilBrandCheck(fn, value) {
  if (fn === null || value === null || typeof value !== 'object') return false;
  try {
    fn.call(value);
    return true;
  } catch (err) {
    return false;
  }
}

var UTIL_TYPED_TAG = utilGetterOf(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag);
var UTIL_ARRAY_BUFFER_LENGTH = utilGetterOf(ArrayBuffer.prototype, 'byteLength');
var UTIL_SHARED_BUFFER_LENGTH = typeof SharedArrayBuffer === 'function' ? utilGetterOf(SharedArrayBuffer.prototype, 'byteLength') : null;
var UTIL_DATA_VIEW_LENGTH = utilGetterOf(DataView.prototype, 'byteLength');

/* the element type name of a typed array (Uint8Array and the rest), or undefined for any other value */
function utilTypedName(value) {
  if (value === null || typeof value !== 'object') return undefined;
  if (UTIL_TYPED_TAG !== null) return UTIL_TYPED_TAG.call(value);
  var tag = Object.prototype.toString.call(value).slice(8, -1);
  return /Array$/.test(tag) ? tag : undefined;
}

function utilTag(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return '';
  return Object.prototype.toString.call(value).slice(8, -1);
}

function utilIsArrayBuffer(value) {
  return utilBrandCheck(UTIL_ARRAY_BUFFER_LENGTH, value);
}

function utilIsSharedArrayBuffer(value) {
  return utilBrandCheck(UTIL_SHARED_BUFFER_LENGTH, value);
}

/* util.types in Node 24's key order */
function utilTypes() {
  function typedIs(name) {
    return function (value) {
      return utilTypedName(value) === name;
    };
  }
  return {
    isArgumentsObject: function (v) { return utilTag(v) === 'Arguments'; },
    isArrayBuffer: utilIsArrayBuffer,
    isAsyncFunction: function (v) {
      var tag = utilTag(v);
      return tag === 'AsyncFunction' || tag === 'AsyncGeneratorFunction';
    },
    isBigIntObject: function (v) { return typeof BigInt === 'function' && utilBrandCheck(BigInt.prototype.valueOf, v); },
    isBooleanObject: function (v) { return utilBrandCheck(Boolean.prototype.valueOf, v); },
    isDataView: function (v) { return utilBrandCheck(UTIL_DATA_VIEW_LENGTH, v); },
    isDate: function (v) { return utilTag(v) === 'Date'; },
    isExternal: function () { return false; },
    isGeneratorFunction: function (v) {
      var tag = utilTag(v);
      return tag === 'GeneratorFunction' || tag === 'AsyncGeneratorFunction';
    },
    isGeneratorObject: function (v) { return utilTag(v) === 'Generator'; },
    isMap: function (v) { return utilBrandCheck(Map.prototype.has, v); },
    isMapIterator: function (v) { return utilTag(v) === 'Map Iterator'; },
    isModuleNamespaceObject: function (v) { return utilTag(v) === 'Module'; },
    isNativeError: function (v) { return utilTag(v) === 'Error'; },
    isNumberObject: function (v) { return utilBrandCheck(Number.prototype.valueOf, v); },
    isPromise: function (v) { return typeof Promise === 'function' && v instanceof Promise; },
    isProxy: function () { return false; },
    isRegExp: function (v) { return utilTag(v) === 'RegExp'; },
    isSet: function (v) { return utilBrandCheck(Set.prototype.has, v); },
    isSetIterator: function (v) { return utilTag(v) === 'Set Iterator'; },
    isSharedArrayBuffer: utilIsSharedArrayBuffer,
    isStringObject: function (v) { return utilBrandCheck(String.prototype.valueOf, v); },
    isSymbolObject: function (v) { return utilBrandCheck(Symbol.prototype.valueOf, v); },
    isWeakMap: function (v) { return utilBrandCheck(WeakMap.prototype.has, v); },
    isWeakSet: function (v) { return utilBrandCheck(WeakSet.prototype.has, v); },
    isAnyArrayBuffer: function (v) { return utilIsArrayBuffer(v) || utilIsSharedArrayBuffer(v); },
    isBoxedPrimitive: function (v) {
      return utilBrandCheck(Number.prototype.valueOf, v) || utilBrandCheck(String.prototype.valueOf, v) ||
        utilBrandCheck(Boolean.prototype.valueOf, v) || utilBrandCheck(Symbol.prototype.valueOf, v) ||
        (typeof BigInt === 'function' && utilBrandCheck(BigInt.prototype.valueOf, v));
    },
    isArrayBufferView: function (v) { return ArrayBuffer.isView(v); },
    isTypedArray: function (v) { return utilTypedName(v) !== undefined; },
    isUint8Array: typedIs('Uint8Array'),
    isUint8ClampedArray: typedIs('Uint8ClampedArray'),
    isUint16Array: typedIs('Uint16Array'),
    isUint32Array: typedIs('Uint32Array'),
    isInt8Array: typedIs('Int8Array'),
    isInt16Array: typedIs('Int16Array'),
    isInt32Array: typedIs('Int32Array'),
    isFloat16Array: typedIs('Float16Array'),
    isFloat32Array: typedIs('Float32Array'),
    isFloat64Array: typedIs('Float64Array'),
    isBigInt64Array: typedIs('BigInt64Array'),
    isBigUint64Array: typedIs('BigUint64Array'),
    isKeyObject: function (v) { return v instanceof requireBuiltin('crypto').KeyObject; },
    isCryptoKey: function (v) { return v instanceof requireBuiltin('crypto').webcrypto.CryptoKey; }
  };
}

/* util.parseArgs: Node's tokenizer and strict checks; the messages are Node's */
function parseArgsImpl(config) {
  var cfg = config === undefined ? {} : config;
  if (cfg === null || typeof cfg !== 'object') {
    throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "config" argument must be of type object.');
  }
  var args = cfg.args !== undefined ? cfg.args : (globalThis.process && Array.isArray(process.argv) ? process.argv.slice(2) : []);
  var strict = cfg.strict !== undefined ? cfg.strict : true;
  var allowPositionals = cfg.allowPositionals !== undefined ? cfg.allowPositionals : !strict;
  var returnTokens = cfg.tokens !== undefined ? cfg.tokens : false;
  var options = cfg.options !== undefined ? cfg.options : Object.create(null);
  if (!Array.isArray(args)) throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "args" argument must be an instance of Array.');
  if (typeof strict !== 'boolean') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "strict" argument must be of type boolean.');
  if (typeof allowPositionals !== 'boolean') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "allowPositionals" argument must be of type boolean.');
  if (typeof returnTokens !== 'boolean') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "tokens" argument must be of type boolean.');
  if (options === null || typeof options !== 'object') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object.');

  var names = Object.keys(options);
  for (var n = 0; n < names.length; n++) {
    var conf = options[names[n]];
    var where = 'options.' + names[n];
    if (conf === null || typeof conf !== 'object') {
      throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "' + where + '" argument must be of type object.');
    }
    if (conf.type !== 'string' && conf.type !== 'boolean') {
      throw utilArgError('ERR_INVALID_ARG_VALUE', "The property '" + where + ".type' must be one of: 'string', 'boolean'.");
    }
    if (conf.short !== undefined) {
      if (typeof conf.short !== 'string') throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "' + where + '.short" property must be of type string.');
      if (conf.short.length !== 1) throw utilArgError('ERR_INVALID_ARG_VALUE', "The property '" + where + ".short' must be a single character.");
    }
    if (conf.multiple !== undefined && typeof conf.multiple !== 'boolean') {
      throw utilArgError('ERR_INVALID_ARG_TYPE', 'The "' + where + '.multiple" property must be of type boolean.');
    }
  }

  function optionTypeOf(name) {
    return Object.prototype.hasOwnProperty.call(options, name) ? options[name].type : undefined;
  }

  function longNameOf(short) {
    for (var k = 0; k < names.length; k++) {
      if (options[names[k]].short === short) return names[k];
    }
    return short;
  }

  function unknownOption(rawName) {
    var hint = allowPositionals
      ? ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- " + JSON.stringify(rawName) + "'"
      : '';
    return utilArgError('ERR_PARSE_ARGS_UNKNOWN_OPTION', "Unknown option '" + rawName + "'" + hint);
  }

  /* phase 1: the argument vector as tokens; a short-option group is expanded in place */
  var tokens = [];
  var index = -1;
  var groupCount = 0;
  var remaining = args.slice();
  while (remaining.length > 0) {
    var arg = remaining.shift();
    var nextArg = remaining[0];
    if (groupCount > 0) groupCount--;
    else index++;
    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index: index });
      while (remaining.length > 0) tokens.push({ kind: 'positional', index: ++index, value: remaining.shift() });
      break;
    }
    var isLong = arg.length > 2 && arg.charAt(0) === '-' && arg.charAt(1) === '-';
    var isShort = arg.length >= 2 && arg.charAt(0) === '-' && arg.charAt(1) !== '-';
    if (isShort && arg.length === 2) {
      var shortName = arg.charAt(1);
      var shortLong = longNameOf(shortName);
      var shortValue = undefined;
      var shortInline = undefined;
      if (optionTypeOf(shortLong) === 'string' && nextArg !== undefined) {
        shortValue = remaining.shift();
        shortInline = false;
      }
      tokens.push({ kind: 'option', name: shortLong, rawName: arg, index: index, value: shortValue, inlineValue: shortInline });
      if (shortValue !== undefined) ++index;
    } else if (isLong && arg.indexOf('=') === -1) {
      var longName = arg.slice(2);
      var longValue = undefined;
      var longInline = undefined;
      if (optionTypeOf(longName) === 'string' && nextArg !== undefined) {
        longValue = remaining.shift();
        longInline = false;
      }
      tokens.push({ kind: 'option', name: longName, rawName: arg, index: index, value: longValue, inlineValue: longInline });
      if (longValue !== undefined) ++index;
    } else if (isLong) {
      var equal = arg.indexOf('=');
      var attachedName = arg.slice(2, equal);
      tokens.push({ kind: 'option', name: attachedName, rawName: '--' + attachedName, index: index, value: arg.slice(equal + 1), inlineValue: true });
    } else if (isShort && optionTypeOf(longNameOf(arg.charAt(1))) === 'string') {
      var attachedShort = arg.charAt(1);
      tokens.push({ kind: 'option', name: longNameOf(attachedShort), rawName: '-' + attachedShort, index: index, value: arg.slice(2), inlineValue: true });
    } else if (isShort) {
      var group = [];
      for (var g = 1; g < arg.length; g++) group.push('-' + arg.charAt(g));
      remaining = group.concat(remaining);
      groupCount = group.length;
    } else {
      tokens.push({ kind: 'positional', index: index, value: arg });
    }
  }

  /* phase 2: strict checks and stored values */
  var values = Object.create(null);
  var positionals = [];
  var result = { values: values, positionals: positionals };
  if (returnTokens) result.tokens = tokens;

  function checkOptionUsage(token) {
    if (!Object.prototype.hasOwnProperty.call(options, token.name)) throw unknownOption(token.rawName);
    var conf = options[token.name];
    var shortAndLong = conf.short !== undefined ? '-' + conf.short + ', --' + token.name : '--' + token.name;
    if (conf.type === 'string' && typeof token.value !== 'string') {
      throw utilArgError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', "Option '" + shortAndLong + " <value>' argument missing");
    }
    if (conf.type === 'boolean' && token.value !== undefined) {
      throw utilArgError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', "Option '" + shortAndLong + "' does not take an argument");
    }
  }

  function checkOptionLikeValue(token) {
    if (!token.inlineValue && typeof token.value === 'string' && token.value.charAt(0) === '-') {
      var isShortForm = token.rawName.length === 2;
      throw utilArgError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
        "Option '" + token.rawName + "' argument is ambiguous.\nDid you forget to specify the option argument for '" + token.rawName +
        "'?\nTo specify an option argument starting with a dash use '--" + token.name + "=-XYZ'" +
        (isShortForm ? " or '" + token.rawName + "-XYZ'" : '') + '.');
    }
  }

  function storeOption(name, value) {
    if (name === '__proto__') return;
    var conf = Object.prototype.hasOwnProperty.call(options, name) ? options[name] : {};
    var stored = value === undefined ? true : value;
    if (conf.multiple) {
      if (values[name] === undefined) values[name] = [];
      values[name].push(stored);
    } else {
      values[name] = stored;
    }
  }

  for (var t = 0; t < tokens.length; t++) {
    var token = tokens[t];
    if (token.kind === 'option') {
      if (strict) {
        checkOptionUsage(token);
        checkOptionLikeValue(token);
      }
      storeOption(token.name, token.value);
    } else if (token.kind === 'positional') {
      if (!allowPositionals) {
        throw utilArgError('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
          "Unexpected argument '" + token.value + "'. This command does not take positional arguments");
      }
      positionals.push(token.value);
    }
  }

  /* phase 3: defaults for options that did not appear */
  for (var d = 0; d < names.length; d++) {
    var dconf = options[names[d]];
    if (values[names[d]] === undefined && dconf.default !== undefined) values[names[d]] = dconf.default;
  }
  return result;
}

BF.util = function () {
  var EE = null;
  var util = {
    format: function () {
      return formatLogArgs(arguments);
    },
    formatWithOptions: function (opts) {
      return formatLogArgs(Array.prototype.slice.call(arguments, 1));
    },
    inspect: function (value, opts) {
      return inspectValue(value, opts);
    },
    inherits: function (ctor, superCtor) {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      Object.setPrototypeOf(ctor, superCtor);
      ctor.super_ = superCtor;
    },
    promisify: function (fn) {
      return function () {
        var self = this;
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          args.push(function (err, value) {
            if (err) reject(err);
            else resolve(value);
          });
          fn.apply(self, args);
        });
      };
    },
    callbackify: function (fn) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        var cb = args.pop();
        fn.apply(this, args).then(function (value) { cb(null, value); }, function (err) { cb(err); });
      };
    },
    deprecate: function (fn) {
      return fn;
    },
    debuglog: function () {
      return function () {};
    },
    isDeepStrictEqual: function (a, b) {
      return deepEqualValues(a, b, true);
    },
    __isDeepEqual: deepEqualValues,
    isArray: Array.isArray,
    isString: function (v) { return typeof v === 'string'; },
    isNumber: function (v) { return typeof v === 'number'; },
    isFunction: function (v) { return typeof v === 'function'; },
    isObject: function (v) { return v !== null && typeof v === 'object'; },
    stripVTControlCharacters: function (s) {
      return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    },
    types: utilTypes(),
    parseArgs: parseArgsImpl,
    TextEncoder: TextEncoderImpl,
    TextDecoder: TextDecoderImpl
  };
  return util;
};

BF['util/types'] = function () {
  return requireBuiltin('util').types;
};

BF.assert = function () {
  var util = requireBuiltin('util');

  function AssertionError(options) {
    var err = new Error(options.message);
    err.name = 'AssertionError';
    err.code = 'ERR_ASSERTION';
    err.actual = options.actual;
    err.expected = options.expected;
    err.operator = options.operator;
    err.generatedMessage = !options.userMessage;
    return err;
  }

  function fail(actual, expected, message, operator, defaultMessage) {
    if (message instanceof Error) throw message;
    throw AssertionError({
      message: message !== undefined ? message : defaultMessage,
      actual: actual,
      expected: expected,
      operator: operator,
      userMessage: message !== undefined
    });
  }

  function assertOk(value, message) {
    if (!value) fail(value, true, message, '==', 'The expression evaluated to a falsy value:\n\n  assert.ok(' + inspectValue(value) + ')\n');
  }

  var assert = function ok() {
    if (arguments.length === 0) fail(undefined, true, undefined, '==', 'No value argument passed to assert.ok()');
    assertOk(arguments[0], arguments[1]);
  };
  assert.ok = assertOk;
  assert.AssertionError = function (options) { return AssertionError(options); };
  assert.fail = function (message) {
    fail(undefined, undefined, message === undefined ? 'Failed' : message, 'fail', 'Failed');
  };
  assert.equal = function (actual, expected, message) {
    if (!(actual == expected || (actual !== actual && expected !== expected))) {
      fail(actual, expected, message, '==', inspectValue(actual) + ' == ' + inspectValue(expected));
    }
  };
  assert.notEqual = function (actual, expected, message) {
    if (actual == expected) fail(actual, expected, message, '!=', inspectValue(actual) + ' != ' + inspectValue(expected));
  };
  assert.strictEqual = function (actual, expected, message) {
    if (!Object.is(actual, expected)) {
      fail(actual, expected, message, 'strictEqual', 'Expected values to be strictly equal:\n\n' + inspectValue(actual) + ' !== ' + inspectValue(expected) + '\n');
    }
  };
  assert.notStrictEqual = function (actual, expected, message) {
    if (Object.is(actual, expected)) fail(actual, expected, message, 'notStrictEqual', 'Expected "actual" to be strictly unequal to: ' + inspectValue(expected));
  };
  assert.deepEqual = function (actual, expected, message) {
    if (!util.__isDeepEqual(actual, expected, false)) fail(actual, expected, message, 'deepEqual', 'Expected values to be loosely deep-equal:\n\n' + inspectValue(actual) + '\n\nshould loosely deep-equal\n\n' + inspectValue(expected));
  };
  assert.deepStrictEqual = function (actual, expected, message) {
    if (!util.__isDeepEqual(actual, expected, true)) fail(actual, expected, message, 'deepStrictEqual', 'Expected values to be strictly deep-equal:\n' + inspectValue(actual) + '\n\nshould equal\n\n' + inspectValue(expected));
  };
  assert.notDeepStrictEqual = function (actual, expected, message) {
    if (util.__isDeepEqual(actual, expected, true)) fail(actual, expected, message, 'notDeepStrictEqual', 'Expected "actual" not to be strictly deep-equal to: ' + inspectValue(expected));
  };
  assert.notDeepEqual = function (actual, expected, message) {
    if (util.__isDeepEqual(actual, expected, false)) fail(actual, expected, message, 'notDeepEqual', 'Expected "actual" not to be loosely deep-equal to: ' + inspectValue(expected));
  };
  assert.throws = function (fn, expected, message) {
    var threw = false;
    var error;
    try {
      fn();
    } catch (e) {
      threw = true;
      error = e;
    }
    if (!threw) fail(undefined, expected, typeof expected === 'string' ? expected : message, 'throws', 'Missing expected exception.');
    if (typeof expected === 'function' && expected.prototype !== undefined && !(error instanceof expected)) throw error;
    if (expected instanceof RegExp && !expected.test(String(error && error.message !== undefined ? error.message : error))) throw error;
  };
  assert.doesNotThrow = function (fn, message) {
    try {
      fn();
    } catch (e) {
      fail(e, undefined, message, 'doesNotThrow', 'Got unwanted exception.\nActual message: "' + (e && e.message) + '"');
    }
  };
  assert.rejects = function (promiseOrFn) {
    var promise = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    return promise.then(function () {
      fail(undefined, undefined, undefined, 'rejects', 'Missing expected rejection.');
    }, function () {
      return undefined;
    });
  };
  assert.match = function (string, regexp, message) {
    if (!regexp.test(string)) fail(string, regexp, message, 'match', 'The input did not match the regular expression ' + String(regexp));
  };
  assert.strict = assert;
  return assert;
};
`;
