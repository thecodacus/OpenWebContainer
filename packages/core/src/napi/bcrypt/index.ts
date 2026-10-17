/*
 * The native binding of the bcrypt package (bcrypt_lib.node, src/bcrypt_node.cc of bcrypt 5.1.1) in
 * JavaScript. createAddon() returns its exports: gen_salt_sync, encrypt_sync, compare_sync and get_rounds,
 * and gen_salt, encrypt and compare, which call back (err, result) once the work is done.
 *
 * Arguments convert as node-addon-api converts them: a string becomes its UTF-8 bytes (a lone surrogate
 * becomes U+FFFD), a typed array its bytes (a DataView fails "Invalid argument"), and the wrong type fails
 * with node-addon-api's TypeError. The asynchronous calls copy their arguments, then run on a later
 * macrotask; their callback must be an object or function, as napi_create_reference requires.
 */
import { bcrypt, genSalt, getRounds, validateSalt } from './bcrypt';

const INVALID_SALT = 'Invalid salt. Salt must be in the form of: $Vers$log2(NumRounds)$saltvalue';

/** V8's String::WriteUtf8 with REPLACE_INVALID_UTF8. */
function utf8(text: string): Uint8Array {
    const out = new Uint8Array(text.length * 3);
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdfff) {
            const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
            if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
                i++;
            } else {
                c = 0xfffd;
            }
        }
        if (c < 0x80) {
            out[n++] = c;
        } else if (c < 0x800) {
            out[n++] = 0xc0 | (c >> 6);
            out[n++] = 0x80 | (c & 0x3f);
        } else if (c < 0x10000) {
            out[n++] = 0xe0 | (c >> 12);
            out[n++] = 0x80 | ((c >> 6) & 0x3f);
            out[n++] = 0x80 | (c & 0x3f);
        } else {
            out[n++] = 0xf0 | (c >> 18);
            out[n++] = 0x80 | ((c >> 12) & 0x3f);
            out[n++] = 0x80 | ((c >> 6) & 0x3f);
            out[n++] = 0x80 | (c & 0x3f);
        }
    }
    return out.slice(0, n);
}

/** Napi::String to std::string: a string, else node-addon-api's napi_string_expected TypeError. */
function stringArg(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('A string was expected');
    return value;
}

/** napi_get_buffer_info on a value napi_is_buffer accepted: a typed array's bytes, copied. */
function bufferBytes(value: ArrayBufferView): Uint8Array {
    if (value instanceof DataView) throw new Error('Invalid argument');
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

/** `info[i].IsBuffer() ? BufferToString(...) : info[i].As<Napi::String>()`: the bytes of a password. */
function dataArg(value: unknown): Uint8Array {
    return ArrayBuffer.isView(value) ? bufferBytes(value) : utf8(stringArg(value));
}

/** A setting or hash as the C code reads it (c_str()): its bytes, a NUL and zero padding. */
function cString(value: unknown): Uint8Array {
    const bytes = utf8(stringArg(value));
    const out = new Uint8Array(bytes.length + 4);
    out.set(bytes);
    return out;
}

/** The C string's bytes up to its first NUL, one character per byte (for strcmp against an ASCII hash). */
function cStringText(s: Uint8Array): string {
    let text = '';
    for (let i = 0; s[i] !== 0; i++) text += String.fromCharCode(s[i]);
    return text;
}

/** A password followed by its NUL terminator, which the 2a and 2b key streams include. */
function keyOf(data: Uint8Array): Uint8Array {
    const key = new Uint8Array(data.length + 1);
    key.set(data);
    return key;
}

/** Napi::Number to int32_t: a number (ToInt32), else node-addon-api's napi_number_expected TypeError. */
function int32Arg(value: unknown): number {
    if (typeof value !== 'number') throw new TypeError('A number was expected');
    return value | 0;
}

/** The salt seed: a 16-byte buffer. */
function seedArg(value: unknown, message: string): Uint8Array {
    if (!ArrayBuffer.isView(value)) throw new TypeError(message);
    const seed = bufferBytes(value);
    if (seed.length !== 16) throw new TypeError(message);
    return seed;
}

/** ToCharVersion(): the first byte of the minor version string, 0 when it is empty. */
function minorOf(value: string): number {
    return value.length === 0 ? 0 : utf8(value)[0];
}

/** The AsyncWorker keeps a reference to its callback; napi_create_reference takes objects, functions and symbols only. */
function callbackArg(value: unknown): unknown {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'symbol')) {
        throw new Error('Invalid argument');
    }
    return value;
}

function callBack(callback: unknown, receiver: unknown, args: unknown[]): void {
    if (typeof callback !== 'function') throw new Error('Invalid argument');
    callback.apply(receiver, args);
}

/**
 * Napi::AsyncWorker: runs execute on a later macrotask, then calls back (undefined, result) (OnOK), or
 * (error) with a fresh object as this when execute throws (OnError).
 */
function queueWork(callback: unknown, execute: () => unknown): void {
    setImmediate(() => {
        let result: unknown;
        try {
            result = execute();
        } catch (error) {
            callBack(callback, {}, [error]);
            return;
        }
        callBack(callback, undefined, [undefined, result]);
    });
}

function hashOf(data: Uint8Array, salt: Uint8Array): string {
    if (!validateSalt(salt)) throw new Error(INVALID_SALT);
    return bcrypt(keyOf(data), data.length, salt);
}

function matches(data: Uint8Array, hash: Uint8Array): boolean {
    return validateSalt(hash) && bcrypt(keyOf(data), data.length, hash) === cStringText(hash);
}

function genSaltSync(args: IArguments): string {
    if (args.length < 3) throw new TypeError('3 arguments expected');
    if (typeof args[0] !== 'string') throw new TypeError('First argument must be a string');
    const seed = seedArg(args[2], 'Third argument must be a 16 byte Buffer');
    const minor = minorOf(args[0]);
    const rounds = int32Arg(args[1]);
    return genSalt(minor, rounds & 0xff, seed);
}

function encryptSync(args: IArguments): string {
    if (args.length < 2) throw new TypeError('2 arguments expected');
    const data = dataArg(args[0]);
    return hashOf(data, cString(args[1]));
}

function compareSync(args: IArguments): boolean {
    if (args.length < 2) throw new TypeError('2 arguments expected');
    const data = dataArg(args[0]);
    return matches(data, cString(args[1]));
}

function getRoundsSync(args: IArguments): number {
    if (args.length < 1) throw new TypeError('1 argument expected');
    const rounds = getRounds(cString(args[0]));
    if (rounds === 0) throw new Error('invalid hash provided');
    return rounds;
}

function genSaltAsync(args: IArguments): undefined {
    if (args.length < 4) throw new TypeError('4 arguments expected');
    if (typeof args[0] !== 'string') throw new TypeError('First argument must be a string');
    const seed = seedArg(args[2], 'Second argument must be a 16 byte Buffer');
    const minor = minorOf(args[0]);
    const rounds = int32Arg(args[1]);
    queueWork(callbackArg(args[3]), () => genSalt(minor, rounds & 0xff, seed));
    return undefined;
}

function encryptAsync(args: IArguments): undefined {
    if (args.length < 3) throw new TypeError('3 arguments expected');
    const data = dataArg(args[0]);
    const salt = cString(args[1]);
    queueWork(callbackArg(args[2]), () => hashOf(data, salt));
    return undefined;
}

function compareAsync(args: IArguments): undefined {
    if (args.length < 3) throw new TypeError('3 arguments expected');
    const data = dataArg(args[0]);
    const hash = cString(args[1]);
    queueWork(callbackArg(args[2]), () => matches(data, hash));
    return undefined;
}

/** A binding function as Napi::Function::New makes it: no name, length 0, any arguments. */
function napiFunction(impl: (args: IArguments) => unknown): Function {
    const fn = function () {
        return impl(arguments);
    };
    Object.defineProperty(fn, 'name', { value: '' });
    return fn;
}

export function createAddon(): object {
    return {
        gen_salt_sync: napiFunction(genSaltSync),
        encrypt_sync: napiFunction(encryptSync),
        compare_sync: napiFunction(compareSync),
        get_rounds: napiFunction(getRoundsSync),
        gen_salt: napiFunction(genSaltAsync),
        encrypt: napiFunction(encryptAsync),
        compare: napiFunction(compareAsync)
    };
}
