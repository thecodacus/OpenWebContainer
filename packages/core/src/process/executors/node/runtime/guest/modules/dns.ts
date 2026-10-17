/**
 * Guest-side dns and dns/promises. Every lookup and query is a callOp to the host's dns.lookup,
 * dns.resolve capability; callbacks run on a later macrotask, as Node delivers them. Plain
 * JavaScript inside a String.raw snippet.
 */
export const SRC = String.raw`
BF['dns'] = function () {
  var resultOrder = 'verbatim';
  var configuredServers = ['127.0.0.1'];
  var RRTYPES = ['A', 'AAAA', 'ANY', 'CAA', 'CNAME', 'MX', 'NAPTR', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'];
  var ORDERS = ['verbatim', 'ipv4first', 'ipv6first'];
  var IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)$/;
  var ERROR_NAMES = {
    NODATA: 'ENODATA', FORMERR: 'EFORMERR', SERVFAIL: 'ESERVFAIL', NOTFOUND: 'ENOTFOUND', NOTIMP: 'ENOTIMP',
    REFUSED: 'EREFUSED', BADQUERY: 'EBADQUERY', BADNAME: 'EBADNAME', BADFAMILY: 'EBADFAMILY', BADRESP: 'EBADRESP',
    CONNREFUSED: 'ECONNREFUSED', TIMEOUT: 'ETIMEOUT', EOF: 'EOF', FILE: 'EFILE', NOMEM: 'ENOMEM',
    DESTRUCTION: 'EDESTRUCTION', BADSTR: 'EBADSTR', BADFLAGS: 'EBADFLAGS', NONAME: 'ENONAME', BADHINTS: 'EBADHINTS',
    NOTINITIALIZED: 'ENOTINITIALIZED', LOADIPHLPAPI: 'ELOADIPHLPAPI', ADDRGETNETWORKPARAMS: 'EADDRGETNETWORKPARAMS',
    CANCELLED: 'ECANCELLED'
  };

  function describeValue(value) {
    if (value === undefined || value === null) return String(value);
    if (typeof value === 'function') return 'function ' + value.name;
    if (typeof value === 'object') return 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object');
    if (typeof value === 'string') return "type string ('" + value + "')";
    return 'type ' + typeof value + ' (' + String(value) + ')';
  }

  function quoteValue(value) {
    return typeof value === 'string' ? "'" + value + "'" : String(value);
  }

  function codedError(Type, code, message) {
    var err = new Type(message);
    err.code = code;
    return err;
  }

  function argTypeError(name, expected, value) {
    return codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "' + name + '" argument must be of type ' + expected + '. Received ' + describeValue(value));
  }

  function dnsError(code, syscall, hostname, errno) {
    var err = new Error(syscall + ' ' + code + ' ' + hostname);
    err.code = code;
    err.syscall = syscall;
    err.hostname = hostname;
    err.errno = errno;
    return err;
  }

  function isIPv4(text) {
    return IPV4_RE.test(text);
  }

  function isIPv6(text) {
    if (typeof text !== 'string' || text.indexOf(':') < 0 || !/^[0-9a-fA-F:.]+$/.test(text)) return false;
    var halves = text.split('::');
    if (halves.length > 2) return false;
    var sections = halves.length === 2 ? halves : [text];
    var groups = 0;
    for (var s = 0; s < sections.length; s++) {
      if (sections[s] === '') continue;
      var items = sections[s].split(':');
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.indexOf('.') >= 0) {
          if (i !== items.length - 1 || s !== sections.length - 1 || !isIPv4(item)) return false;
          groups += 2;
        } else if (/^[0-9a-fA-F]{1,4}$/.test(item)) {
          groups += 1;
        } else {
          return false;
        }
      }
    }
    return halves.length === 2 ? groups < 8 : groups === 8;
  }

  function isIP(text) {
    return isIPv4(text) || isIPv6(text);
  }

  function syscallFor(rrtype) {
    return 'query' + rrtype.charAt(0) + rrtype.slice(1).toLowerCase();
  }

  function checkServers(servers) {
    if (!Array.isArray(servers)) throw argTypeError('servers', 'Array', servers);
    var out = [];
    for (var i = 0; i < servers.length; i++) {
      var text = String(servers[i]);
      if (!isIP(text)) throw codedError(TypeError, 'ERR_INVALID_IP_ADDRESS', 'Invalid IP address: ' + text);
      out.push(text);
    }
    return out;
  }

  function parseLookupOptions(options) {
    var family = 0;
    var all = false;
    var order = resultOrder;
    if (typeof options === 'number') {
      family = options;
    } else if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw argTypeError('options', 'object or integer', options);
      if (options.family !== undefined) family = options.family;
      all = options.all === true;
      if (options.verbatim === true) order = 'verbatim';
      else if (options.verbatim === false) order = 'ipv4first';
    }
    if (family === 'IPv4') family = 4;
    else if (family === 'IPv6') family = 6;
    if (family !== 0 && family !== 4 && family !== 6) {
      throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE',
        "The property 'options.family' must be one of: 0, 4, 6. Received " + quoteValue(family));
    }
    return { family: family, all: all, order: order };
  }

  function orderAddresses(list, order) {
    if (order !== 'ipv6first') return list;
    return list.filter(function (entry) { return entry.family === 6; })
      .concat(list.filter(function (entry) { return entry.family !== 6; }));
  }

  function operation(op, args, hostname) {
    return callOp(op, args).then(null, function (err) {
      if (err && typeof err === 'object') {
        err.hostname = hostname;
        if (!('errno' in err)) err.errno = undefined;
      }
      throw err;
    });
  }

  // Node 24 keeps an own 'type' key (undefined) on SOA and NAPTR records; JSON transport drops it, so restore it here.
  function decorate(rrtype, value) {
    if (rrtype === 'SOA' && value && typeof value === 'object') value.type = undefined;
    if (rrtype === 'NAPTR' && Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) value[i].type = undefined;
    }
    return value;
  }

  function trackedQuery(owner, hostname, rrtype, reverseLookup) {
    return new Promise(function (resolve, reject) {
      var pending = owner ? owner._pending : null;
      var syscall = reverseLookup ? 'getHostByAddr' : syscallFor(rrtype);
      var entry = { settled: false, cancel: null };
      var settle = function (fn, value) {
        if (entry.settled) return;
        entry.settled = true;
        if (pending) {
          var at = pending.indexOf(entry);
          if (at >= 0) pending.splice(at, 1);
        }
        fn(value);
      };
      entry.cancel = function () {
        settle(reject, dnsError('ECANCELLED', syscall, hostname));
      };
      if (pending) pending.push(entry);
      operation('dns.resolve', { name: hostname, rrtype: rrtype, reverse: reverseLookup === true }, hostname).then(
        function (value) { settle(resolve, decorate(rrtype, value)); },
        function (err) { settle(reject, err); }
      );
    });
  }

  function deliver(promise, callback) {
    promise.then(function (value) {
      setImmediateImpl(function () { callback(null, value); });
    }, function (err) {
      setImmediateImpl(function () { callback(err); });
    });
  }

  function lookup(hostname, options, callback) {
    if (hostname && typeof hostname !== 'string') throw argTypeError('hostname', 'string', hostname);
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    var opts = parseLookupOptions(options);
    if (typeof callback !== 'function') throw argTypeError('callback', 'function', callback);
    if (!hostname) {
      setImmediateImpl(function () {
        if (opts.all) callback(null, []);
        else callback(null, null, opts.family === 6 ? 6 : 4);
      });
      return;
    }
    operation('dns.lookup', { hostname: hostname, family: opts.family }, hostname).then(function (result) {
      var list = orderAddresses(result.addresses, opts.order);
      setImmediateImpl(function () {
        if (opts.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      });
    }, function (err) {
      setImmediateImpl(function () { callback(err); });
    });
  }

  // Every query method takes its callback last. resolve4(name, [options], cb) and resolveMx(name, cb)
  // share one body; resolve(name, [rrtype], cb) defaults to A. Called on a Resolver, this owns the query.
  function queryMethod(fixedType) {
    return function () {
      var args = arguments;
      var hostname = args[0];
      var callback = args[args.length - 1];
      var rrtype = fixedType;
      if (rrtype === null) {
        rrtype = args.length > 2 && args[1] !== undefined ? args[1] : 'A';
        if (typeof rrtype !== 'string') throw argTypeError('rrtype', 'string', rrtype);
        if (RRTYPES.indexOf(rrtype) < 0) {
          throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE',
            "The argument 'rrtype' is invalid. Received " + quoteValue(rrtype));
        }
      }
      if (typeof hostname !== 'string') throw argTypeError('name', 'string', hostname);
      if (typeof callback !== 'function') throw argTypeError('callback', 'function', callback);
      deliver(trackedQuery(this && this._pending ? this : null, hostname, rrtype, false), callback);
    };
  }

  function reverse(ip, callback) {
    if (typeof ip !== 'string') throw argTypeError('ip', 'string', ip);
    if (typeof callback !== 'function') throw argTypeError('callback', 'function', callback);
    if (!isIP(ip)) throw dnsError('EINVAL', 'getHostByAddr', ip, -22);
    deliver(trackedQuery(this && this._pending ? this : null, ip, 'PTR', true), callback);
  }

  function Resolver(options) {
    this._pending = [];
    this._servers = configuredServers.slice(0);
  }

  Resolver.prototype.cancel = function () {
    var list = this._pending.slice(0);
    for (var i = 0; i < list.length; i++) list[i].cancel();
  };
  Resolver.prototype.getServers = function () {
    return this._servers.slice(0);
  };
  Resolver.prototype.setServers = function (servers) {
    this._servers = checkServers(servers);
  };
  Resolver.prototype.setLocalAddress = function (ipv4, ipv6) {};
  Resolver.prototype.resolve = queryMethod(null);
  Resolver.prototype.resolve4 = queryMethod('A');
  Resolver.prototype.resolve6 = queryMethod('AAAA');
  Resolver.prototype.resolveAny = queryMethod('ANY');
  Resolver.prototype.resolveCaa = queryMethod('CAA');
  Resolver.prototype.resolveCname = queryMethod('CNAME');
  Resolver.prototype.resolveMx = queryMethod('MX');
  Resolver.prototype.resolveNaptr = queryMethod('NAPTR');
  Resolver.prototype.resolveNs = queryMethod('NS');
  Resolver.prototype.resolvePtr = queryMethod('PTR');
  Resolver.prototype.resolveSoa = queryMethod('SOA');
  Resolver.prototype.resolveSrv = queryMethod('SRV');
  Resolver.prototype.resolveTxt = queryMethod('TXT');
  Resolver.prototype.reverse = reverse;

  // The virtual network has no DNS servers of its own: queries go to the DoH endpoint, so this list
  // is bookkeeping only. It starts as a loopback placeholder.
  function setServers(servers) {
    configuredServers = checkServers(servers);
  }

  function getServers() {
    return configuredServers.slice(0);
  }

  function setDefaultResultOrder(order) {
    if (ORDERS.indexOf(order) < 0) {
      throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE',
        "The argument 'dnsOrder' must be one of: 'verbatim', 'ipv4first', 'ipv6first'. Received " + quoteValue(order));
    }
    resultOrder = order;
  }

  function getDefaultResultOrder() {
    return resultOrder;
  }

  var dns = {
    lookup: lookup,
    resolve: queryMethod(null),
    resolve4: queryMethod('A'),
    resolve6: queryMethod('AAAA'),
    resolveAny: queryMethod('ANY'),
    resolveCaa: queryMethod('CAA'),
    resolveCname: queryMethod('CNAME'),
    resolveMx: queryMethod('MX'),
    resolveNaptr: queryMethod('NAPTR'),
    resolveNs: queryMethod('NS'),
    resolvePtr: queryMethod('PTR'),
    resolveSoa: queryMethod('SOA'),
    resolveSrv: queryMethod('SRV'),
    resolveTxt: queryMethod('TXT'),
    reverse: reverse,
    getServers: getServers,
    setServers: setServers,
    getDefaultResultOrder: getDefaultResultOrder,
    setDefaultResultOrder: setDefaultResultOrder,
    Resolver: Resolver
  };
  Object.keys(ERROR_NAMES).forEach(function (key) {
    dns[key] = ERROR_NAMES[key];
  });
  dns.ADDRCONFIG = 1024;
  dns.ALL = 256;
  dns.V4MAPPED = 2048;
  Object.defineProperty(dns, 'promises', {
    enumerable: true,
    configurable: true,
    get: function () { return requireBuiltin('dns/promises'); }
  });
  return dns;
};

BF['dns/promises'] = function () {
  var dns = requireBuiltin('dns');
  var QUERY_METHODS = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
    'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
  var out = {};

  // The callback method runs on the Resolver instance when there is one, so its pending queries are its own.
  function promisified(name) {
    return function () {
      var target = this && this._inner ? this._inner : dns;
      var args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        args.push(function (err, value) {
          if (err) reject(err);
          else resolve(value);
        });
        target[name].apply(target, args);
      });
    };
  }

  for (var i = 0; i < QUERY_METHODS.length; i++) {
    out[QUERY_METHODS[i]] = promisified(QUERY_METHODS[i]);
  }

  out.lookup = function (hostname, options) {
    var all = options !== null && typeof options === 'object' && options.all === true;
    return new Promise(function (resolve, reject) {
      dns.lookup(hostname, options, function (err, address, family) {
        if (err) reject(err);
        else if (all) resolve(address);
        else resolve({ address: address, family: family });
      });
    });
  };

  function PromisesResolver(options) {
    this._inner = new dns.Resolver(options);
  }
  for (var j = 0; j < QUERY_METHODS.length; j++) {
    PromisesResolver.prototype[QUERY_METHODS[j]] = promisified(QUERY_METHODS[j]);
  }
  PromisesResolver.prototype.cancel = function () {
    this._inner.cancel();
  };
  PromisesResolver.prototype.getServers = function () {
    return this._inner.getServers();
  };
  PromisesResolver.prototype.setServers = function (servers) {
    this._inner.setServers(servers);
  };
  PromisesResolver.prototype.setLocalAddress = function (ipv4, ipv6) {
    this._inner.setLocalAddress(ipv4, ipv6);
  };

  out.Resolver = PromisesResolver;
  out.getServers = dns.getServers;
  out.setServers = dns.setServers;
  out.getDefaultResultOrder = dns.getDefaultResultOrder;
  out.setDefaultResultOrder = dns.setDefaultResultOrder;
  Object.keys(dns).forEach(function (key) {
    if (/^[A-Z]+$/.test(key) && typeof dns[key] === 'string') out[key] = dns[key];
  });
  return out;
};
`;
