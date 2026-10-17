/**
 * Guest-side `path` (posix, ported from Node's normalizeString algorithm) and
 * `events` (EventEmitter) built-ins. Plain JavaScript inside a String.raw snippet.
 */
export const PATH_SRC = String.raw`
/* path.win32: Windows path rules (backslash separator, drive letters, UNC roots), ported from Node's win32 algorithm */
function makeWin32Path() {
  function assertPath(p) {
    if (typeof p !== 'string') throw new TypeError('The "path" argument must be of type string. Received ' + typeof p);
  }

  function isSep(code) {
    return code === 47 || code === 92;
  }

  function isDeviceRoot(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }

  function normalizeWin(path, allowAboveRoot) {
    var res = '';
    var lastSegmentLength = 0;
    var lastSlash = -1;
    var dots = 0;
    var code = 0;
    for (var i = 0; i <= path.length; ++i) {
      if (i < path.length) code = path.charCodeAt(i);
      else if (isSep(code)) break;
      else code = 47;
      if (isSep(code)) {
        if (lastSlash === i - 1 || dots === 1) {
          // noop
        } else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
            if (res.length > 2) {
              var lastSlashIndex = res.lastIndexOf('\\');
              if (lastSlashIndex === -1) {
                res = '';
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSlashIndex);
                lastSegmentLength = res.length - 1 - res.lastIndexOf('\\');
              }
              lastSlash = i;
              dots = 0;
              continue;
            } else if (res.length !== 0) {
              res = '';
              lastSegmentLength = 0;
              lastSlash = i;
              dots = 0;
              continue;
            }
          }
          if (allowAboveRoot) {
            res += res.length > 0 ? '\\..' : '..';
            lastSegmentLength = 2;
          }
        } else {
          if (res.length > 0) res += '\\' + path.slice(lastSlash + 1, i);
          else res = path.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i;
        dots = 0;
      } else if (code === 46 && dots !== -1) {
        ++dots;
      } else {
        dots = -1;
      }
    }
    return res;
  }

  var win32 = {
    sep: '\\',
    delimiter: ';',
    resolve: function () {
      var resolvedDevice = '';
      var resolvedTail = '';
      var resolvedAbsolute = false;
      for (var i = arguments.length - 1; i >= -1; i--) {
        var p;
        if (i >= 0) {
          p = arguments[i];
          assertPath(p);
          if (p.length === 0) continue;
        } else if (resolvedDevice.length === 0) {
          p = host.cwd();
        } else {
          p = host.cwd();
          if (p.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() && p.charCodeAt(2) === 92) {
            p = resolvedDevice + '\\';
          }
        }
        var len = p.length;
        var rootEnd = 0;
        var device = '';
        var isAbs = false;
        var code = p.charCodeAt(0);
        if (len === 1) {
          if (isSep(code)) {
            rootEnd = 1;
            isAbs = true;
          }
        } else if (isSep(code)) {
          isAbs = true;
          if (isSep(p.charCodeAt(1))) {
            var j = 2;
            var last = j;
            while (j < len && !isSep(p.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              var firstPart = p.slice(last, j);
              last = j;
              while (j < len && isSep(p.charCodeAt(j))) j++;
              if (j < len && j !== last) {
                last = j;
                while (j < len && !isSep(p.charCodeAt(j))) j++;
                if (j === len || j !== last) {
                  device = '\\\\' + firstPart + '\\' + p.slice(last, j);
                  rootEnd = j;
                }
              }
            }
          } else {
            rootEnd = 1;
          }
        } else if (isDeviceRoot(code) && p.charCodeAt(1) === 58) {
          device = p.slice(0, 2);
          rootEnd = 2;
          if (len > 2 && isSep(p.charCodeAt(2))) {
            isAbs = true;
            rootEnd = 3;
          }
        }
        if (device.length > 0) {
          if (resolvedDevice.length > 0) {
            if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
          } else {
            resolvedDevice = device;
          }
        }
        if (resolvedAbsolute) {
          if (resolvedDevice.length > 0) break;
        } else {
          resolvedTail = p.slice(rootEnd) + '\\' + resolvedTail;
          resolvedAbsolute = isAbs;
          if (isAbs && resolvedDevice.length > 0) break;
        }
      }
      resolvedTail = normalizeWin(resolvedTail, !resolvedAbsolute);
      if (resolvedAbsolute) return resolvedDevice + '\\' + resolvedTail;
      return (resolvedDevice + resolvedTail) || '.';
    },
    normalize: function (p) {
      assertPath(p);
      var len = p.length;
      if (len === 0) return '.';
      var rootEnd = 0;
      var device;
      var isAbs = false;
      var code = p.charCodeAt(0);
      if (len === 1) return isSep(code) ? '\\' : p;
      if (isSep(code)) {
        isAbs = true;
        if (isSep(p.charCodeAt(1))) {
          var j = 2;
          var last = j;
          while (j < len && !isSep(p.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            var firstPart = p.slice(last, j);
            last = j;
            while (j < len && isSep(p.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !isSep(p.charCodeAt(j))) j++;
              if (j === len) return '\\\\' + firstPart + '\\' + p.slice(last) + '\\';
              if (j !== last) {
                device = '\\\\' + firstPart + '\\' + p.slice(last, j);
                rootEnd = j;
              }
            }
          }
        } else {
          rootEnd = 1;
        }
      } else if (isDeviceRoot(code) && p.charCodeAt(1) === 58) {
        device = p.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && isSep(p.charCodeAt(2))) {
          isAbs = true;
          rootEnd = 3;
        }
      }
      var tail = rootEnd < len ? normalizeWin(p.slice(rootEnd), !isAbs) : '';
      if (tail.length === 0 && !isAbs) tail = '.';
      if (tail.length > 0 && isSep(p.charCodeAt(len - 1))) tail += '\\';
      if (device === undefined) return isAbs ? '\\' + tail : tail;
      return isAbs ? device + '\\' + tail : device + tail;
    },
    isAbsolute: function (p) {
      assertPath(p);
      var len = p.length;
      if (len === 0) return false;
      var code = p.charCodeAt(0);
      return isSep(code) || (len > 2 && isDeviceRoot(code) && p.charCodeAt(1) === 58 && isSep(p.charCodeAt(2)));
    },
    join: function () {
      if (arguments.length === 0) return '.';
      var joined;
      var firstPart;
      for (var i = 0; i < arguments.length; ++i) {
        var arg = arguments[i];
        assertPath(arg);
        if (arg.length > 0) {
          if (joined === undefined) joined = firstPart = arg;
          else joined += '\\' + arg;
        }
      }
      if (joined === undefined) return '.';
      var needsReplace = true;
      var slashCount = 0;
      if (isSep(firstPart.charCodeAt(0))) {
        ++slashCount;
        var firstLen = firstPart.length;
        if (firstLen > 1 && isSep(firstPart.charCodeAt(1))) {
          ++slashCount;
          if (firstLen > 2) {
            if (isSep(firstPart.charCodeAt(2))) ++slashCount;
            else needsReplace = false;
          }
        }
      }
      if (needsReplace) {
        while (slashCount < joined.length && isSep(joined.charCodeAt(slashCount))) slashCount++;
        if (slashCount >= 2) joined = '\\' + joined.slice(slashCount);
      }
      return win32.normalize(joined);
    },
    relative: function (from, to) {
      assertPath(from);
      assertPath(to);
      if (from === to) return '';
      var fromAbs = win32.resolve(from);
      var toAbs = win32.resolve(to);
      if (fromAbs.toLowerCase() === toAbs.toLowerCase()) return '';
      var fromParts = fromAbs.split('\\').filter(Boolean);
      var toParts = toAbs.split('\\').filter(Boolean);
      if (fromParts.length > 0 && toParts.length > 0 && fromParts[0].toLowerCase() !== toParts[0].toLowerCase()) return toAbs;
      var common = 0;
      while (common < fromParts.length && common < toParts.length && fromParts[common].toLowerCase() === toParts[common].toLowerCase()) common++;
      var out = [];
      for (var a = common; a < fromParts.length; a++) out.push('..');
      for (var b = common; b < toParts.length; b++) out.push(toParts[b]);
      return out.join('\\');
    },
    dirname: function (p) {
      assertPath(p);
      var len = p.length;
      if (len === 0) return '.';
      var rootEnd = -1;
      var offset = 0;
      var code = p.charCodeAt(0);
      if (len === 1) return isSep(code) ? p : '.';
      if (isSep(code)) {
        rootEnd = offset = 1;
        if (isSep(p.charCodeAt(1))) {
          var j = 2;
          var last = j;
          while (j < len && !isSep(p.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && isSep(p.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !isSep(p.charCodeAt(j))) j++;
              if (j === len) return p;
              if (j !== last) rootEnd = offset = j + 1;
            }
          }
        }
      } else if (isDeviceRoot(code) && p.charCodeAt(1) === 58) {
        rootEnd = offset = len > 2 && isSep(p.charCodeAt(2)) ? 3 : 2;
      }
      var end = -1;
      var matchedSlash = true;
      for (var i = len - 1; i >= offset; --i) {
        if (isSep(p.charCodeAt(i))) {
          if (!matchedSlash) {
            end = i;
            break;
          }
        } else {
          matchedSlash = false;
        }
      }
      if (end === -1) {
        if (rootEnd === -1) return '.';
        end = rootEnd;
      }
      return p.slice(0, end);
    },
    basename: function (p, suffix) {
      if (suffix !== undefined) assertPath(suffix);
      assertPath(p);
      var start = 0;
      var end = -1;
      var matchedSlash = true;
      var i;
      if (p.length >= 2 && isDeviceRoot(p.charCodeAt(0)) && p.charCodeAt(1) === 58) start = 2;
      if (suffix !== undefined && suffix.length > 0 && suffix.length <= p.length) {
        if (suffix === p) return '';
        var extIdx = suffix.length - 1;
        var firstNonSlashEnd = -1;
        for (i = p.length - 1; i >= start; --i) {
          var code = p.charCodeAt(i);
          if (isSep(code)) {
            if (!matchedSlash) {
              start = i + 1;
              break;
            }
          } else {
            if (firstNonSlashEnd === -1) {
              matchedSlash = false;
              firstNonSlashEnd = i + 1;
            }
            if (extIdx >= 0) {
              if (code === suffix.charCodeAt(extIdx)) {
                if (--extIdx === -1) end = i;
              } else {
                extIdx = -1;
                end = firstNonSlashEnd;
              }
            }
          }
        }
        if (start === end) end = firstNonSlashEnd;
        else if (end === -1) end = p.length;
        return p.slice(start, end);
      }
      for (i = p.length - 1; i >= start; --i) {
        if (isSep(p.charCodeAt(i))) {
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else if (end === -1) {
          matchedSlash = false;
          end = i + 1;
        }
      }
      if (end === -1) return '';
      return p.slice(start, end);
    },
    extname: function (p) {
      assertPath(p);
      var start = 0;
      var startDot = -1;
      var startPart = 0;
      var end = -1;
      var matchedSlash = true;
      var preDotState = 0;
      if (p.length >= 2 && p.charCodeAt(1) === 58 && isDeviceRoot(p.charCodeAt(0))) {
        start = 2;
        startPart = 2;
      }
      for (var i = p.length - 1; i >= start; --i) {
        var code = p.charCodeAt(i);
        if (isSep(code)) {
          if (!matchedSlash) {
            startPart = i + 1;
            break;
          }
          continue;
        }
        if (end === -1) {
          matchedSlash = false;
          end = i + 1;
        }
        if (code === 46) {
          if (startDot === -1) startDot = i;
          else if (preDotState !== 1) preDotState = 1;
        } else if (startDot !== -1) {
          preDotState = -1;
        }
      }
      if (startDot === -1 || end === -1 || preDotState === 0 ||
          (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
        return '';
      }
      return p.slice(startDot, end);
    },
    parse: function (p) {
      assertPath(p);
      var ret = { root: '', dir: '', base: '', ext: '', name: '' };
      if (p.length === 0) return ret;
      var len = p.length;
      var rootEnd = 0;
      var code = p.charCodeAt(0);
      if (len === 1) {
        if (isSep(code)) ret.root = ret.dir = p;
        else ret.base = ret.name = p;
        return ret;
      }
      if (isSep(code)) {
        rootEnd = 1;
        if (isSep(p.charCodeAt(1))) {
          var j = 2;
          var last = j;
          while (j < len && !isSep(p.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && isSep(p.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !isSep(p.charCodeAt(j))) j++;
              if (j === len) rootEnd = j;
              else if (j !== last) rootEnd = j + 1;
            }
          }
        }
      } else if (isDeviceRoot(code) && p.charCodeAt(1) === 58) {
        if (len <= 2) {
          ret.root = ret.dir = p;
          return ret;
        }
        rootEnd = 2;
        if (isSep(p.charCodeAt(2))) {
          if (len === 3) {
            ret.root = ret.dir = p;
            return ret;
          }
          rootEnd = 3;
        }
      }
      if (rootEnd > 0) ret.root = p.slice(0, rootEnd);
      var startDot = -1;
      var startPart = rootEnd;
      var end = -1;
      var matchedSlash = true;
      var preDotState = 0;
      for (var i = len - 1; i >= rootEnd; --i) {
        code = p.charCodeAt(i);
        if (isSep(code)) {
          if (!matchedSlash) {
            startPart = i + 1;
            break;
          }
          continue;
        }
        if (end === -1) {
          matchedSlash = false;
          end = i + 1;
        }
        if (code === 46) {
          if (startDot === -1) startDot = i;
          else if (preDotState !== 1) preDotState = 1;
        } else if (startDot !== -1) {
          preDotState = -1;
        }
      }
      if (end !== -1) {
        if (startDot === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
          ret.base = ret.name = p.slice(startPart, end);
        } else {
          ret.name = p.slice(startPart, startDot);
          ret.base = p.slice(startPart, end);
          ret.ext = p.slice(startDot, end);
        }
      }
      if (startPart > 0 && startPart !== rootEnd) ret.dir = p.slice(0, startPart - 1);
      else ret.dir = ret.root;
      return ret;
    },
    format: function (o) {
      if (o === null || typeof o !== 'object') throw new TypeError('The "pathObject" argument must be of type object');
      var dir = o.dir || o.root;
      var ext = o.ext ? (o.ext.charAt(0) === '.' ? o.ext : '.' + o.ext) : '';
      var base = o.base || ((o.name || '') + ext);
      if (!dir) return base;
      return dir === o.root ? dir + base : dir + '\\' + base;
    },
    toNamespacedPath: function (p) {
      if (typeof p !== 'string' || p.length === 0) return p;
      var resolved = win32.resolve(p);
      if (resolved.length <= 2) return p;
      if (resolved.charCodeAt(0) === 92) {
        if (resolved.charCodeAt(1) === 92) {
          var code = resolved.charCodeAt(2);
          if (code !== 63 && code !== 46) return '\\\\?\\UNC\\' + resolved.slice(2);
        }
      } else if (isDeviceRoot(resolved.charCodeAt(0)) && resolved.charCodeAt(1) === 58 && resolved.charCodeAt(2) === 92) {
        return '\\\\?\\' + resolved;
      }
      return p;
    }
  };
  return win32;
}

BF.path = function () {
  function assertPath(p) {
    if (typeof p !== 'string') throw new TypeError('The "path" argument must be of type string. Received ' + typeof p);
  }

  function normalizeString(path, allowAboveRoot) {
    var res = '';
    var lastSegmentLength = 0;
    var lastSlash = -1;
    var dots = 0;
    var code = 0;
    for (var i = 0; i <= path.length; ++i) {
      if (i < path.length) code = path.charCodeAt(i);
      else if (code === 47) break;
      else code = 47;
      if (code === 47) {
        if (lastSlash === i - 1 || dots === 1) {
          // noop
        } else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
            if (res.length > 2) {
              var lastSlashIndex = res.lastIndexOf('/');
              if (lastSlashIndex === -1) {
                res = '';
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSlashIndex);
                lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
              }
              lastSlash = i;
              dots = 0;
              continue;
            } else if (res.length !== 0) {
              res = '';
              lastSegmentLength = 0;
              lastSlash = i;
              dots = 0;
              continue;
            }
          }
          if (allowAboveRoot) {
            res += res.length > 0 ? '/..' : '..';
            lastSegmentLength = 2;
          }
        } else {
          if (res.length > 0) res += '/' + path.slice(lastSlash + 1, i);
          else res = path.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i;
        dots = 0;
      } else if (code === 46 && dots !== -1) {
        ++dots;
      } else {
        dots = -1;
      }
    }
    return res;
  }

  var posix = {
    sep: '/',
    delimiter: ':',
    resolve: function () {
      var resolvedPath = '';
      var resolvedAbsolute = false;
      for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
        var p = i >= 0 ? arguments[i] : host.cwd();
        assertPath(p);
        if (p.length === 0) continue;
        resolvedPath = p + '/' + resolvedPath;
        resolvedAbsolute = p.charCodeAt(0) === 47;
      }
      resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
      if (resolvedAbsolute) return '/' + resolvedPath;
      return resolvedPath.length > 0 ? resolvedPath : '.';
    },
    normalize: function (p) {
      assertPath(p);
      if (p.length === 0) return '.';
      var isAbs = p.charCodeAt(0) === 47;
      var trailing = p.charCodeAt(p.length - 1) === 47;
      p = normalizeString(p, !isAbs);
      if (p.length === 0) {
        if (isAbs) return '/';
        return trailing ? './' : '.';
      }
      if (trailing) p += '/';
      return isAbs ? '/' + p : p;
    },
    isAbsolute: function (p) {
      assertPath(p);
      return p.length > 0 && p.charCodeAt(0) === 47;
    },
    join: function () {
      if (arguments.length === 0) return '.';
      var joined;
      for (var i = 0; i < arguments.length; ++i) {
        var arg = arguments[i];
        assertPath(arg);
        if (arg.length > 0) joined = joined === undefined ? arg : joined + '/' + arg;
      }
      if (joined === undefined) return '.';
      return posix.normalize(joined);
    },
    relative: function (from, to) {
      assertPath(from);
      assertPath(to);
      if (from === to) return '';
      from = posix.resolve(from);
      to = posix.resolve(to);
      if (from === to) return '';
      var fromParts = from.split('/').filter(Boolean);
      var toParts = to.split('/').filter(Boolean);
      var common = 0;
      while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
      var out = [];
      for (var a = common; a < fromParts.length; a++) out.push('..');
      for (var b = common; b < toParts.length; b++) out.push(toParts[b]);
      return out.join('/');
    },
    dirname: function (p) {
      assertPath(p);
      if (p.length === 0) return '.';
      var hasRoot = p.charCodeAt(0) === 47;
      var end = -1;
      var matchedSlash = true;
      for (var i = p.length - 1; i >= 1; --i) {
        if (p.charCodeAt(i) === 47) {
          if (!matchedSlash) {
            end = i;
            break;
          }
        } else {
          matchedSlash = false;
        }
      }
      if (end === -1) return hasRoot ? '/' : '.';
      if (hasRoot && end === 1) return '//';
      return p.slice(0, end);
    },
    basename: function (p, ext) {
      if (ext !== undefined) assertPath(ext);
      assertPath(p);
      var end = p.length;
      while (end > 1 && p.charCodeAt(end - 1) === 47) end--;
      var trimmed = p.slice(0, end);
      var idx = trimmed.lastIndexOf('/');
      var base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
      if (ext !== undefined && base !== ext && base.length > ext.length && base.slice(-ext.length) === ext) {
        base = base.slice(0, base.length - ext.length);
      }
      return base;
    },
    extname: function (p) {
      assertPath(p);
      var base = posix.basename(p);
      var idx = base.lastIndexOf('.');
      if (idx <= 0) return '';
      return base.slice(idx);
    },
    parse: function (p) {
      assertPath(p);
      var ret = { root: '', dir: '', base: '', ext: '', name: '' };
      if (p.length === 0) return ret;
      if (p.charCodeAt(0) === 47) ret.root = '/';
      ret.base = posix.basename(p);
      ret.ext = posix.extname(p);
      ret.name = ret.ext ? ret.base.slice(0, ret.base.length - ret.ext.length) : ret.base;
      if (p.indexOf('/') >= 0) ret.dir = posix.dirname(p);
      return ret;
    },
    format: function (o) {
      var dir = o.dir || o.root;
      var ext = o.ext ? (o.ext.charAt(0) === '.' ? o.ext : '.' + o.ext) : '';
      var base = o.base || ((o.name || '') + ext);
      if (!dir) return base;
      return dir === o.root ? dir + base : dir + '/' + base;
    },
    toNamespacedPath: function (p) {
      return p;
    }
  };
  var win32 = makeWin32Path();
  posix.posix = posix;
  posix.win32 = win32;
  win32.posix = posix;
  win32.win32 = win32;
  return posix;
};

BF['path/posix'] = function () {
  return requireBuiltin('path').posix;
};

BF['path/win32'] = function () {
  return requireBuiltin('path').win32;
};

BF.events = function () {
  function checkListener(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('The "listener" argument must be of type function. Received ' + typeof listener);
    }
  }

  function EventEmitter() {
    EventEmitter.init.call(this);
  }

  EventEmitter.init = function () {
    if (this._events === undefined) {
      this._events = Object.create(null);
      this._eventsCount = 0;
    }
    this._maxListeners = this._maxListeners || undefined;
  };
  EventEmitter.prototype._events = undefined;
  EventEmitter.prototype._eventsCount = 0;
  EventEmitter.prototype._maxListeners = undefined;
  EventEmitter.defaultMaxListeners = 10;

  function addListener(target, type, listener, prepend) {
    checkListener(listener);
    if (target._events === undefined) {
      target._events = Object.create(null);
      target._eventsCount = 0;
    }
    var events = target._events;
    if (events.newListener !== undefined) {
      target.emit('newListener', type, listener.listener ? listener.listener : listener);
    }
    var existing = events[type];
    if (existing === undefined) {
      events[type] = listener;
      target._eventsCount++;
    } else if (typeof existing === 'function') {
      events[type] = prepend ? [listener, existing] : [existing, listener];
    } else if (prepend) {
      existing.unshift(listener);
    } else {
      existing.push(listener);
    }
    return target;
  }

  function wrapOnce(target, type, listener) {
    var fired = false;
    var wrapped = function () {
      if (fired) return undefined;
      fired = true;
      target.removeListener(type, wrapped);
      return listener.apply(target, arguments);
    };
    wrapped.listener = listener;
    return wrapped;
  }

  EventEmitter.prototype.on = function (type, listener) {
    return addListener(this, type, listener, false);
  };
  EventEmitter.prototype.addListener = EventEmitter.prototype.on;
  EventEmitter.prototype.prependListener = function (type, listener) {
    return addListener(this, type, listener, true);
  };
  EventEmitter.prototype.once = function (type, listener) {
    checkListener(listener);
    return this.on(type, wrapOnce(this, type, listener));
  };
  EventEmitter.prototype.prependOnceListener = function (type, listener) {
    checkListener(listener);
    return this.prependListener(type, wrapOnce(this, type, listener));
  };
  EventEmitter.prototype.removeListener = function (type, listener) {
    checkListener(listener);
    var events = this._events;
    if (events === undefined) return this;
    var list = events[type];
    if (list === undefined) return this;
    if (list === listener || list.listener === listener) {
      delete events[type];
      this._eventsCount--;
      if (events.removeListener !== undefined) this.emit('removeListener', type, listener);
    } else if (typeof list !== 'function') {
      var pos = -1;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          pos = i;
          break;
        }
      }
      if (pos < 0) return this;
      list.splice(pos, 1);
      if (list.length === 1) events[type] = list[0];
      if (events.removeListener !== undefined) this.emit('removeListener', type, listener);
    }
    return this;
  };
  EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
  EventEmitter.prototype.removeAllListeners = function (type) {
    if (this._events === undefined) return this;
    if (type === undefined) {
      this._events = Object.create(null);
      this._eventsCount = 0;
    } else if (this._events[type] !== undefined) {
      delete this._events[type];
      this._eventsCount--;
    }
    return this;
  };
  EventEmitter.prototype.emit = function (type) {
    var args = Array.prototype.slice.call(arguments, 1);
    var events = this._events;
    if (type === 'error' && events !== undefined && events[kErrorMonitor] !== undefined) {
      this.emit.apply(this, [kErrorMonitor].concat(args));
    }
    if (type === 'error' && (events === undefined || events.error === undefined)) {
      var er = args[0];
      if (er instanceof Error) throw er;
      var err = new Error('Unhandled error.' + (er === undefined ? '' : ' (' + inspectValue(er) + ')'));
      err.code = 'ERR_UNHANDLED_ERROR';
      err.context = er;
      throw err;
    }
    if (events === undefined) return false;
    var handler = events[type];
    if (handler === undefined) return false;
    if (typeof handler === 'function') {
      handler.apply(this, args);
    } else {
      var list = handler.slice();
      for (var i = 0; i < list.length; i++) list[i].apply(this, args);
    }
    return true;
  };
  EventEmitter.prototype.rawListeners = function (type) {
    var events = this._events;
    if (events === undefined || events[type] === undefined) return [];
    var h = events[type];
    return typeof h === 'function' ? [h] : h.slice();
  };
  EventEmitter.prototype.listeners = function (type) {
    return this.rawListeners(type).map(function (l) { return l.listener || l; });
  };
  EventEmitter.prototype.listenerCount = function (type) {
    var events = this._events;
    if (events === undefined || events[type] === undefined) return 0;
    var h = events[type];
    return typeof h === 'function' ? 1 : h.length;
  };
  EventEmitter.prototype.eventNames = function () {
    return this._events === undefined ? [] : Reflect.ownKeys(this._events);
  };
  EventEmitter.prototype.setMaxListeners = function (n) {
    this._maxListeners = n;
    return this;
  };
  EventEmitter.prototype.getMaxListeners = function () {
    return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners;
  };
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.listenerCount = function (emitter, type) {
    return emitter.listenerCount(type);
  };
  /* events.once: resolves with the argument array; the error listener it added is removed once the event arrives */
  EventEmitter.once = function (emitter, name) {
    return new Promise(function (resolve, reject) {
      var onEvent = function () {
        if (name !== 'error') emitter.removeListener('error', onError);
        resolve(Array.prototype.slice.call(arguments));
      };
      var onError = function (err) {
        emitter.removeListener(name, onEvent);
        reject(err);
      };
      emitter.once(name, onEvent);
      if (name !== 'error') emitter.once('error', onError);
    });
  };
  /* events.on: an async iterator of argument arrays; break or return() removes its listeners */
  EventEmitter.on = function (emitter, name) {
    var queued = [];
    var waiting = [];
    var failure = null;
    var finished = false;
    function onEvent() {
      var args = Array.prototype.slice.call(arguments);
      if (waiting.length > 0) waiting.shift().resolve({ value: args, done: false });
      else queued.push(args);
    }
    function onError(err) {
      if (waiting.length > 0) waiting.shift().reject(err);
      else failure = err;
      close();
    }
    function close() {
      if (finished) return;
      finished = true;
      emitter.removeListener(name, onEvent);
      if (name !== 'error') emitter.removeListener('error', onError);
      while (waiting.length > 0) waiting.shift().resolve({ value: undefined, done: true });
    }
    emitter.on(name, onEvent);
    if (name !== 'error') emitter.on('error', onError);
    var iterator = {
      next: function () {
        if (queued.length > 0) return Promise.resolve({ value: queued.shift(), done: false });
        if (failure !== null) {
          var err = failure;
          failure = null;
          return Promise.reject(err);
        }
        if (finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise(function (resolve, reject) {
          waiting.push({ resolve: resolve, reject: reject });
        });
      },
      return: function () {
        close();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: function (err) {
        failure = err;
        close();
        return Promise.reject(err);
      }
    };
    iterator[Symbol.asyncIterator] = function () { return this; };
    return iterator;
  };
  var kErrorMonitor = Symbol('events.errorMonitor');
  EventEmitter.errorMonitor = kErrorMonitor;
  EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');
  EventEmitter.captureRejections = false;
  EventEmitter.getEventListeners = function (emitter, name) {
    return emitter.listeners(name);
  };
  EventEmitter.getMaxListeners = function (emitter) {
    return emitter.getMaxListeners();
  };
  EventEmitter.setMaxListeners = function (n) {
    var limit = n !== undefined ? n : EventEmitter.defaultMaxListeners;
    var targets = Array.prototype.slice.call(arguments, 1);
    if (targets.length === 0) {
      EventEmitter.defaultMaxListeners = limit;
    } else {
      for (var i = 0; i < targets.length; i++) targets[i].setMaxListeners(limit);
    }
  };
  return EventEmitter;
};
`;
