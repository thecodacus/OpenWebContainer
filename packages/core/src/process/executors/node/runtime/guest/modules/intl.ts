/**
 * Guest-side Intl: DateTimeFormat, NumberFormat, Collator, PluralRules, RelativeTimeFormat, ListFormat and
 * getCanonicalLocales, delegating every operation to the host through the intl.call capability
 * (capabilities/intl.ts). Also routes Date, Number, BigInt, Array and typed-array toLocaleString and String
 * localeCompare through the same host Intl, so their output matches Node. Plain JavaScript inside a String.raw
 * snippet, wrapped in one IIFE so that only the Intl global is introduced.
 */
export const SRC = String.raw`
(function () {
  var STATE = new WeakMap();
  var getTime = Date.prototype.getTime;
  var numberValueOf = Number.prototype.valueOf;
  var bigintValueOf = typeof BigInt === 'function' ? BigInt.prototype.valueOf : null;

  function intlFailure(error) {
    if (error && error.code === 'ERR_INTL_RANGE') return new RangeError(error.message);
    if (error && error.code === 'ERR_INTL_TYPE') return new TypeError(error.message);
    return error;
  }

  function intlCall(kind, locales, options, value, method) {
    var args = { kind: kind, locales: locales, options: options, value: value };
    if (method !== undefined) args.method = method;
    try {
      return callCap('intl.call', args);
    } catch (error) {
      throw intlFailure(error);
    }
  }

  function toStr(value) {
    if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    return String(value);
  }

  function toNumber(value) {
    if (typeof value === 'bigint') throw new TypeError('Cannot convert a BigInt value to a number');
    return Number(value);
  }

  function encodeNumber(n) {
    if (n !== n) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (n === 0 && 1 / n < 0) return '-0';
    return n;
  }

  function encodeOperand(value) {
    if (typeof value === 'number') return encodeNumber(value);
    if (typeof value === 'bigint') return { bigint: String(value) };
    if (typeof value === 'string') return { str: value };
    return encodeNumber(toNumber(value));
  }

  function encodeTime(date) {
    if (date === undefined) return Date.now();
    return encodeNumber(toNumber(date));
  }

  function localesArg(locales) {
    if (locales === null || typeof locales !== 'object') return locales;
    var items = Array.prototype.slice.call(locales);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var tag = items[i];
      out.push(tag !== null && typeof tag === 'object' ? String(tag) : tag);
    }
    return out;
  }

  function optionsArg(options) {
    if (options === null || typeof options !== 'object') return options;
    return JSON.parse(JSON.stringify(options));
  }

  function initState(self, name, locales, options) {
    var st = { name: name, locales: localesArg(locales), options: optionsArg(options), bound: null, resolved: null };
    st.resolved = intlCall('resolvedOptions', st.locales, st.options, name);
    STATE.set(self, st);
  }

  function stateOf(self, name) {
    var st = self !== null && (typeof self === 'object' || typeof self === 'function') ? STATE.get(self) : undefined;
    if (st === undefined || st.name !== name) {
      throw new TypeError('Method called on an incompatible receiver, expected Intl.' + name);
    }
    return st;
  }

  function defineHidden(target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: true, enumerable: false, configurable: true });
  }

  function defineAccessor(target, key, getter) {
    Object.defineProperty(target, key, { get: getter, enumerable: false, configurable: true });
  }

  function defineTag(target, tagName) {
    Object.defineProperty(target, Symbol.toStringTag, { value: tagName, configurable: true });
  }

  function defineMethod(target, key, length, fn) {
    Object.defineProperty(fn, 'name', { value: key, configurable: true });
    Object.defineProperty(fn, 'length', { value: length, configurable: true });
    defineHidden(target, key, fn);
  }

  function installStatics(ctor, name) {
    defineHidden(ctor.prototype, 'resolvedOptions', function resolvedOptions() {
      return JSON.parse(JSON.stringify(stateOf(this, name).resolved));
    });
    defineHidden(ctor, 'supportedLocalesOf', function supportedLocalesOf(locales, options) {
      return intlCall('supportedLocalesOf', localesArg(locales), optionsArg(options), name);
    });
    defineTag(ctor.prototype, 'Intl.' + name);
  }

  function DateTimeFormat(locales, options) {
    if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locales, options);
    initState(this, 'DateTimeFormat', locales, options);
  }
  defineAccessor(DateTimeFormat.prototype, 'format', function () {
    var st = stateOf(this, 'DateTimeFormat');
    if (st.bound === null) {
      st.bound = function (date) { return intlCall('dateFormat', st.locales, st.options, encodeTime(date)); };
    }
    return st.bound;
  });
  defineHidden(DateTimeFormat.prototype, 'formatToParts', function formatToParts(date) {
    var st = stateOf(this, 'DateTimeFormat');
    return intlCall('dateFormatToParts', st.locales, st.options, encodeTime(date));
  });
  installStatics(DateTimeFormat, 'DateTimeFormat');

  function NumberFormat(locales, options) {
    if (!(this instanceof NumberFormat)) return new NumberFormat(locales, options);
    initState(this, 'NumberFormat', locales, options);
  }
  defineAccessor(NumberFormat.prototype, 'format', function () {
    var st = stateOf(this, 'NumberFormat');
    if (st.bound === null) {
      st.bound = function (value) { return intlCall('numberFormat', st.locales, st.options, encodeOperand(value)); };
    }
    return st.bound;
  });
  defineHidden(NumberFormat.prototype, 'formatToParts', function formatToParts(value) {
    var st = stateOf(this, 'NumberFormat');
    return intlCall('numberFormatToParts', st.locales, st.options, encodeOperand(value));
  });
  installStatics(NumberFormat, 'NumberFormat');

  function Collator(locales, options) {
    if (!(this instanceof Collator)) return new Collator(locales, options);
    initState(this, 'Collator', locales, options);
  }
  defineAccessor(Collator.prototype, 'compare', function () {
    var st = stateOf(this, 'Collator');
    if (st.bound === null) {
      st.bound = function (a, b) { return intlCall('collate', st.locales, st.options, [toStr(a), toStr(b)]); };
    }
    return st.bound;
  });
  installStatics(Collator, 'Collator');

  function PluralRules(locales, options) {
    if (!(this instanceof PluralRules)) throw new TypeError("Constructor Intl.PluralRules requires 'new'");
    initState(this, 'PluralRules', locales, options);
  }
  defineHidden(PluralRules.prototype, 'select', function select(value) {
    var st = stateOf(this, 'PluralRules');
    return intlCall('pluralSelect', st.locales, st.options, encodeNumber(toNumber(value)));
  });
  installStatics(PluralRules, 'PluralRules');

  function RelativeTimeFormat(locales, options) {
    if (!(this instanceof RelativeTimeFormat)) throw new TypeError("Constructor Intl.RelativeTimeFormat requires 'new'");
    initState(this, 'RelativeTimeFormat', locales, options);
  }
  defineHidden(RelativeTimeFormat.prototype, 'format', function format(value, unit) {
    var st = stateOf(this, 'RelativeTimeFormat');
    var amount = encodeNumber(toNumber(value));
    return intlCall('relativeFormat', st.locales, st.options, [amount, toStr(unit)]);
  });
  installStatics(RelativeTimeFormat, 'RelativeTimeFormat');

  function ListFormat(locales, options) {
    if (!(this instanceof ListFormat)) throw new TypeError("Constructor Intl.ListFormat requires 'new'");
    initState(this, 'ListFormat', locales, options);
  }
  defineHidden(ListFormat.prototype, 'format', function format(list) {
    var st = stateOf(this, 'ListFormat');
    var items = [];
    for (var item of list) items.push(item);
    return intlCall('listFormat', st.locales, st.options, items);
  });
  installStatics(ListFormat, 'ListFormat');

  var IntlObject = {};
  defineTag(IntlObject, 'Intl');
  defineHidden(IntlObject, 'DateTimeFormat', DateTimeFormat);
  defineHidden(IntlObject, 'NumberFormat', NumberFormat);
  defineHidden(IntlObject, 'Collator', Collator);
  defineHidden(IntlObject, 'PluralRules', PluralRules);
  defineHidden(IntlObject, 'RelativeTimeFormat', RelativeTimeFormat);
  defineHidden(IntlObject, 'ListFormat', ListFormat);
  defineHidden(IntlObject, 'getCanonicalLocales', function getCanonicalLocales(locales) {
    return intlCall('canonicalLocales', localesArg(locales));
  });
  defineHidden(IntlObject, 'supportedValuesOf', function supportedValuesOf(key) {
    return intlCall('supportedValuesOf', undefined, undefined, toStr(key));
  });
  if (typeof globalThis.Intl === 'undefined') {
    Object.defineProperty(globalThis, 'Intl', { value: IntlObject, writable: true, enumerable: false, configurable: true });
  }

  function dateLocaleMethod(method) {
    return function (locales, options) {
      var time = getTime.call(this);
      if (time !== time) return 'Invalid Date';
      return intlCall('dateToLocale', localesArg(locales), optionsArg(options), encodeNumber(time), method);
    };
  }
  defineMethod(Date.prototype, 'toLocaleString', 0, dateLocaleMethod('toLocaleString'));
  defineMethod(Date.prototype, 'toLocaleDateString', 0, dateLocaleMethod('toLocaleDateString'));
  defineMethod(Date.prototype, 'toLocaleTimeString', 0, dateLocaleMethod('toLocaleTimeString'));

  defineMethod(Number.prototype, 'toLocaleString', 0, function toLocaleString(locales, options) {
    var number = numberValueOf.call(this);
    return intlCall('numberFormat', localesArg(locales), optionsArg(options), encodeNumber(number));
  });

  if (bigintValueOf !== null) {
    defineMethod(BigInt.prototype, 'toLocaleString', 0, function toLocaleString(locales, options) {
      var big = bigintValueOf.call(this);
      return intlCall('numberFormat', localesArg(locales), optionsArg(options), { bigint: String(big) });
    });
  }

  defineMethod(String.prototype, 'localeCompare', 1, function localeCompare(that, locales, options) {
    if (this === undefined || this === null) throw new TypeError('String.prototype.localeCompare called on null or undefined');
    var self = toStr(this);
    var other = toStr(that);
    return intlCall('collate', localesArg(locales), optionsArg(options), [self, other]);
  });

  function localeJoin(locales, options) {
    if (this === undefined || this === null) throw new TypeError('Array.prototype.toLocaleString called on null or undefined');
    var object = Object(this);
    var length = object.length >>> 0;
    var out = '';
    for (var k = 0; k < length; k++) {
      if (k > 0) out += ',';
      var element = object[k];
      if (element !== undefined && element !== null) out += toStr(element.toLocaleString(locales, options));
    }
    return out;
  }
  defineMethod(Array.prototype, 'toLocaleString', 0, function toLocaleString(locales, options) {
    return localeJoin.call(this, locales, options);
  });
  var TypedArrayPrototype = Object.getPrototypeOf(Int8Array.prototype);
  if (typeof TypedArrayPrototype.toLocaleString === 'function') {
    defineMethod(TypedArrayPrototype, 'toLocaleString', 0, function toLocaleString(locales, options) {
      return localeJoin.call(this, locales, options);
    });
  }
})();
`;
