/*
 * The argument conversions of the sodium-native add-on: what node-addon-api's Napi::TypedArray and the
 * add-on's own SN_ARGV / SN_ASSERT_LENGTH macros do. Every message here was read off the real add-on
 * (sodium-native 4.3.3 on Node 24.15) by passing it the offending argument, never written from the
 * C headers: an argument that is not a typed array fails with a TypeError naming the parameter, a
 * length assertion fails with a plain Error naming both the parameter and the constant, and a call
 * with fewer arguments than the binding declares fails with a TypeError naming the binding.
 */

/** The stable code every unimplemented binding throws with. */
export const UNSUPPORTED_CODE = 'ERR_OWC_NAPI_SODIUM_UNSUPPORTED';

/** The error an unimplemented binding throws: named, so a caller can grep the code out of the message. */
export function unsupportedError(name: string, reason: string): Error {
    const error = new Error(
        'sodium-native: ' + name + ' is not implemented by the owc JavaScript shim (' + reason + ') [' + UNSUPPORTED_CODE + ']'
    );
    (error as { code?: string }).code = UNSUPPORTED_CODE;
    return error;
}

/**
 * The wrapper in sodium-native 5 hands every buffer to the binding as its backing ArrayBuffer followed
 * by a byte offset and a byte length, so a call that looks like four typed arrays arrives as twelve
 * arguments. Fold each (ArrayBuffer, offset, length) triple back into one view before the binding sees
 * it, which is what the add-on receives on Node: the add-on's own parameters are typed arrays.
 */
function foldBufferTriples(args: IArguments): unknown[] {
    const folded: unknown[] = [];
    let index = 0;
    while (index < args.length) {
        const value = args[index];
        const offset = args[index + 1];
        const length = args[index + 2];
        if (value instanceof ArrayBuffer && typeof offset === 'number' && typeof length === 'number') {
            folded.push(new Uint8Array(value, offset, length));
            index += 3;
            continue;
        }
        folded.push(value);
        index++;
    }
    return folded;
}

/** A binding function as Napi::Function::New makes it: no name, length 0, any arguments. */
/** Rebuild the arguments object the bindings expect from the folded values. */
function asArguments(values: unknown[]): IArguments {
    const rebuilt: { [index: number]: unknown; length: number } = { length: values.length };
    for (let i = 0; i < values.length; i++) rebuilt[i] = values[i];
    return rebuilt as unknown as IArguments;
}

/**
 * The add-on's crypto_ bindings return a status the caller checks, and sodium-native 5 throws
 * "status: undefined" when a binding returns nothing. Return 0 for those: success, which is what the
 * add-on returns, and leave the bindings that legitimately return a value alone.
 */
function withStatus(impl: (args: IArguments) => unknown): (args: IArguments) => unknown {
    return function (args: IArguments): unknown {
        const result = impl(args);
        return result === undefined ? 0 : result;
    };
}

export function napiFunction(impl: (args: IArguments) => unknown, name?: string): Function {
    const bound = name && name.startsWith('crypto_') ? withStatus(impl) : impl;
    const fn = function () {
        const args =
            arguments.length && arguments[0] instanceof ArrayBuffer ? asArguments(foldBufferTriples(arguments)) : arguments;
        return bound(args);
    };
    Object.defineProperty(fn, 'name', { value: '' });
    return fn;
}

/**
 * Napi::TypedArray over a value napi_is_typedarray accepted. A DataView is an ArrayBuffer view but
 * not a typed array, so the add-on rejects it with the same message as a number.
 */
export function typedArray(value: unknown, name: string): Uint8Array {
    if (!ArrayBuffer.isView(value) || value instanceof DataView) {
        throw new TypeError(name + ' must be an instance of TypedArray');
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** An optional trailing typed array: absent means a zero-length one, which is what the binding sees. */
export function optionalTypedArray(value: unknown, name: string): Uint8Array {
    if (value === undefined) return new Uint8Array(0);
    return typedArray(value, name);
}

/** SN_ARGV: the binding declares `count` arguments and rejects fewer. */
export function argv(args: IArguments, count: number, name: string): void {
    if (args.length < count) throw new TypeError(name + ' requires ' + count + ' argument(s)');
}

/**
 * SN_ARGV_OPTS: the binding declares a range of argument counts, but only the lower bound is enforced
 * - the add-on accepts a crypto_generichash call carrying a fourth argument, measured. An optional
 * argument that is absent is not the same thing as one that is present and empty.
 */
export function argvOpts(args: IArguments, min: number, name: string): void {
    if (args.length < min) throw new TypeError(name + ' requires ' + min + ' argument(s)');
}

/** SN_ASSERT_LENGTH: `<name>` must be exactly `constantName` bytes long. */
export function assertLength(size: number, expected: number, name: string, constantName: string): void {
    if (size !== expected) throw new Error('"' + name + '" must be ' + constantName + ' bytes long');
}

/** SN_ASSERT_MIN_LENGTH: `<name>` must be at least `constantName` bytes long. */
export function assertMinLength(size: number, min: number, name: string, constantName: string): void {
    if (size < min) throw new Error('"' + name + '" must be at least ' + constantName + ' bytes long');
}

/** SN_ASSERT_MAX_LENGTH: `<name>` must be at most `constantName` bytes long. */
export function assertMaxLength(size: number, max: number, name: string, constantName: string): void {
    if (size > max) throw new Error('"' + name + '" must be at most ' + constantName + ' bytes long');
}

/** SN_THROWS with a message the add-on writes out verbatim, constants and all. */
export function throws(condition: boolean, message: string): void {
    if (condition) throw new Error(message);
}

/** Napi::Number to uint32_t. */
export function uint32(value: unknown, name: string): number {
    if (typeof value !== 'number') throw new TypeError(name + ' must be an instance of Number');
    return value >>> 0;
}

/** Copies bytes into a caller-owned buffer, which is always big enough by the time this runs. */
export function write(dest: Uint8Array, source: Uint8Array): void {
    dest.set(source.subarray(0, dest.length));
}
