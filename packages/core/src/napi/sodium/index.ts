/*
 * The native binding of the sodium-native package (sodium-native.node, src/binding.c of
 * sodium-native 4.3.3) in JavaScript. createAddon() returns its exports: the same 298 names the real
 * add-on exports, 141 of them constants and 157 functions, with the argument conversion, the length
 * assertions and the error messages of the real binding.
 *
 * Only the functions listed in IMPLEMENTED are computed here. Everything else is exported as a
 * function that throws an Error carrying the code ERR_OWC_NAPI_SODIUM_UNSUPPORTED, so a caller that
 * probes `typeof sodium.crypto_pwhash === 'function'` still sees an add-on, and a caller that runs it
 * gets a named, greppable reason instead of a crash inside a fake.
 *
 * Randomness comes from globalThis.crypto.getRandomValues, which packages/core installs in the guest
 * realm, so randombytes_buf is as random as the host lets it be and never falls back to something
 * predictable.
 */
import { SODIUM_CONSTANTS, SODIUM_CONSTANT_NAMES } from './constants';
import { SODIUM_FUNCTION_NAMES } from './surface';
import {
    argv,
    argvOpts,
    assertLength,
    assertMaxLength,
    assertMinLength,
    napiFunction,
    optionalTypedArray,
    throws,
    typedArray,
    uint32,
    UNSUPPORTED_CODE,
    unsupportedError
} from './support';
import {
    AeadKind,
    aeadOpen,
    aeadSeal,
    auth,
    beforenm,
    chacha20,
    constantTimeEqual,
    ed25519,
    edwardsToMontgomeryPriv,
    edwardsToMontgomeryPub,
    generichash,
    kdfDerive,
    kxSeedKeypair,
    kxSessionKeys,
    onetimeauth,
    randomValues,
    randomUint32,
    secretboxOpen,
    secretboxSeal,
    sha256,
    sha512,
    uniform,
    x25519
} from './primitives';

const SECRETBOX_MACBYTES = 16;
const SECRETBOX_NONCEBYTES = 24;
const SECRETBOX_KEYBYTES = 32;
const BOX_MACBYTES = 16;
const BOX_NONCEBYTES = 24;
const BOX_PUBLICKEYBYTES = 32;
const BOX_SECRETKEYBYTES = 32;
const BOX_SEEDBYTES = 32;
const SIGN_BYTES = 64;
const SIGN_PUBLICKEYBYTES = 32;
const SIGN_SECRETKEYBYTES = 64;
const SIGN_SEEDBYTES = 32;
const GENERICHASH_BYTES_MIN = 16;
const GENERICHASH_BYTES_MAX = 64;
const GENERICHASH_KEYBYTES = 32;
const GENERICHASH_KEYBYTES_MIN = 16;
const GENERICHASH_KEYBYTES_MAX = 64;
const HASH_SHA256_BYTES = 32;
const HASH_SHA512_BYTES = 64;
const HASH_BYTES = 64;
const AUTH_BYTES = 32;
const AUTH_KEYBYTES = 32;
const SCALARMULT_BYTES = 32;
const SCALARMULT_SCALARBYTES = 32;
const RANDOMBYTES_SEEDBYTES = 32;
const ONETIMEAUTH_BYTES = 16;
const ONETIMEAUTH_KEYBYTES = 32;
const AEAD_KEYBYTES = 32;
const AEAD_CHACHA_NPUBBYTES = 12;
const AEAD_XCHACHA_NPUBBYTES = 24;
const CHACHA20_IETF_NONCEBYTES = 12;
const CHACHA20_IETF_KEYBYTES = 32;
const KDF_BYTES_MIN = 16;
const KDF_BYTES_MAX = 64;
const KDF_CONTEXTBYTES = 8;
const KDF_KEYBYTES = 32;
const KX_PUBLICKEYBYTES = 32;
const KX_SECRETKEYBYTES = 32;
const KX_SEEDBYTES = 32;
const KX_SESSIONKEYBYTES = 32;

/** The nonce of randombytes_buf_deterministic, which libsodium spells out in randombytes.c. */
const DETERMINISTIC_NONCE = new Uint8Array([0x4c, 0x69, 0x62, 0x73, 0x6f, 0x64, 0x69, 0x75, 0x6d, 0x44, 0x52, 0x47]);

function randombytes_buf(args: IArguments): undefined | Uint8Array {
    argv(args, 1, 'randombytes_buf');
    // Two shapes: randombytes_buf(size) hands back a new buffer, and randombytes_buf(buf) fills one. The
    // wrapper in sodium-native 5 also passes the backing ArrayBuffer with an offset and a length.
    if (typeof args[0] === 'number') {
        const size = uint32(args[0], 'size');
        const generated = allocBuffer(size);
        generated.set(randomValues(size));
        return generated;
    }
    if (args[0] instanceof ArrayBuffer) {
        const offset = uint32(args[1], 'byteOffset');
        const length = uint32(args[2], 'byteLength');
        new Uint8Array(args[0], offset, length).set(randomValues(length));
        return undefined;
    }
    const buf = typedArray(args[0], 'buf');
    buf.set(randomValues(buf.length));
    return undefined;
}

function randombytes_buf_deterministic(args: IArguments): undefined {
    argv(args, 2, 'randombytes_buf');
    const buf = typedArray(args[0], 'buf');
    const seed = typedArray(args[1], 'seed');
    assertLength(seed.length, RANDOMBYTES_SEEDBYTES, 'seed', 'randombytes_SEEDBYTES');
    if (buf.length === 0) return undefined;
    buf.set(chacha20(seed, DETERMINISTIC_NONCE, new Uint8Array(buf.length)).subarray(0, buf.length));
    return undefined;
}

function randombytes_random(): number {
    return randomUint32();
}

function randombytes_uniform(args: IArguments): number {
    argv(args, 1, 'randombytes_uniform');
    return uniform(uint32(args[0], 'upper_bound'));
}

/*
 * The guarded heap. The container cannot place guard pages around an allocation and cannot lock it, so
 * sodium_malloc returns an ordinary zero-filled Buffer, sodium_free zeroes it, and sodium_mprotect_*
 * and sodium_mlock do nothing and report success. These are hardening operations: they do not change
 * any computed value, and refusing them throws at module load in packages such as sodium-native 3.x,
 * which would take the caller down before it runs. The reason is printed once so it is not silent.
 */
const GUARDED_HEAP_NOTE =
    'sodium-native: the container has no guarded heap and cannot lock memory, so sodium_malloc returns an ordinary zero-filled Buffer and sodium_mprotect_* and sodium_mlock do nothing';
let guardedHeapWarned = false;

function warnGuardedHeap(): void {
    if (guardedHeapWarned) return;
    guardedHeapWarned = true;
    const console = (globalThis as { console?: { warn?: (message: string) => void } }).console;
    try {
        console?.warn?.(GUARDED_HEAP_NOTE);
    } catch {
        /* no console to warn on */
    }
}

function allocBuffer(size: number): Uint8Array {
    const BufferCtor = (globalThis as { Buffer?: { alloc(size: number): Uint8Array } }).Buffer;
    return typeof BufferCtor?.alloc === 'function' ? BufferCtor.alloc(size) : new Uint8Array(size);
}

function sodium_malloc(args: IArguments): Uint8Array {
    argv(args, 1, 'sodium_malloc');
    warnGuardedHeap();
    return allocBuffer(uint32(args[0], 'size'));
}

function sodium_free(args: IArguments): undefined {
    argv(args, 1, 'sodium_free');
    warnGuardedHeap();
    typedArray(args[0], 'buf').fill(0);
    return undefined;
}

function sodiumMprotect(name: string): (args: IArguments) => undefined {
    return function (args: IArguments): undefined {
        argv(args, 1, name);
        typedArray(args[0], 'buf');
        warnGuardedHeap();
        return undefined;
    };
}

function sodium_mlock(args: IArguments): number {
    argv(args, 2, 'sodium_mlock');
    typedArray(args[0], 'buf');
    uint32(args[1], 'len');
    warnGuardedHeap();
    return 0;
}

function sodium_munlock(args: IArguments): number {
    argv(args, 2, 'sodium_munlock');
    typedArray(args[0], 'buf');
    uint32(args[1], 'len');
    warnGuardedHeap();
    return 0;
}

function sodium_memzero(args: IArguments): undefined {
    argv(args, 1, 'sodium_memzero');
    typedArray(args[0], 'buf').fill(0);
    return undefined;
}

function sodium_memcmp(args: IArguments): boolean {
    argv(args, 2, 'sodium_memcmp');
    const b1 = typedArray(args[0], 'b1');
    const b2 = typedArray(args[1], 'b2');
    throws(b1.length !== b2.length, 'buffers must be of same length');
    return constantTimeEqual(b1, b2);
}

function sodium_is_zero(args: IArguments): boolean {
    argvOpts(args, 1, 'sodium_is_zero');
    const a = typedArray(args[0], 'a');
    const length = args.length > 1 ? uint32(args[1], 'len') : a.length;
    throws(length > a.length, "len must be shorter than 'buf.byteLength'");
    for (let i = 0; i < length; i++) if (a[i] !== 0) return false;
    return true;
}

function sodium_increment(args: IArguments): undefined {
    argv(args, 1, 'sodium_increment');
    const n = typedArray(args[0], 'n');
    let carry = 1;
    for (let i = 0; i < n.length && carry; i++) {
        const sum = n[i] + carry;
        n[i] = sum & 0xff;
        carry = sum >> 8;
    }
    return undefined;
}

function sodium_add(args: IArguments): undefined {
    argv(args, 2, 'sodium_add');
    const a = typedArray(args[0], 'a');
    const b = typedArray(args[1], 'b');
    throws(a.length !== b.length, 'buffers must be of same length');
    let carry = 0;
    for (let i = 0; i < a.length; i++) {
        const sum = a[i] + b[i] + carry;
        a[i] = sum & 0xff;
        carry = sum >> 8;
    }
    return undefined;
}

function sodium_sub(args: IArguments): undefined {
    argv(args, 2, 'sodium_sub');
    const a = typedArray(args[0], 'a');
    const b = typedArray(args[1], 'b');
    throws(a.length !== b.length, 'buffers must be of same length');
    let borrow = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i] - borrow;
        a[i] = diff & 0xff;
        borrow = diff < 0 ? 1 : 0;
    }
    return undefined;
}

/** sodium_compare reads both buffers as little-endian numbers, so the last byte is the most significant. */
function sodium_compare(args: IArguments): number {
    argv(args, 2, 'sodium_compare');
    const a = typedArray(args[0], 'a');
    const b = typedArray(args[1], 'b');
    throws(a.length !== b.length, 'buffers must be of same length');
    for (let i = a.length - 1; i >= 0; i--) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

function crypto_secretbox_easy(args: IArguments): undefined {
    argv(args, 4, 'crypto_secretbox_easy');
    const c = typedArray(args[0], 'c');
    const m = typedArray(args[1], 'm');
    const n = typedArray(args[2], 'n');
    const k = typedArray(args[3], 'k');
    throws(c.length !== m.length + SECRETBOX_MACBYTES, "c must be 'm.byteLength + crypto_secretbox_MACBYTES' bytes");
    assertLength(n.length, SECRETBOX_NONCEBYTES, 'n', 'crypto_secretbox_NONCEBYTES');
    assertLength(k.length, SECRETBOX_KEYBYTES, 'k', 'crypto_secretbox_KEYBYTES');
    const { ct, mac } = secretboxSeal(m, n, k);
    c.set(mac, 0);
    c.set(ct, SECRETBOX_MACBYTES);
    return undefined;
}

function crypto_secretbox_open_easy(args: IArguments): boolean {
    argv(args, 4, 'crypto_secretbox_open_easy');
    const m = typedArray(args[0], 'm');
    const c = typedArray(args[1], 'c');
    const n = typedArray(args[2], 'n');
    const k = typedArray(args[3], 'k');
    throws(m.length !== c.length - SECRETBOX_MACBYTES, "m must be 'c - crypto_secretbox_MACBYTES' bytes");
    assertMinLength(c.length, SECRETBOX_MACBYTES, 'c', 'crypto_secretbox_MACBYTES');
    assertLength(n.length, SECRETBOX_NONCEBYTES, 'n', 'crypto_secretbox_NONCEBYTES');
    assertLength(k.length, SECRETBOX_KEYBYTES, 'k', 'crypto_secretbox_KEYBYTES');
    return secretboxOpen(m, c.subarray(SECRETBOX_MACBYTES), c.subarray(0, SECRETBOX_MACBYTES), n, k);
}

function crypto_secretbox_detached(args: IArguments): undefined {
    argv(args, 5, 'crypto_secretbox_detached');
    const c = typedArray(args[0], 'c');
    const mac = typedArray(args[1], 'mac');
    const m = typedArray(args[2], 'm');
    const n = typedArray(args[3], 'n');
    const k = typedArray(args[4], 'k');
    throws(c.length !== m.length, "c must 'm.byteLength' bytes");
    assertLength(mac.length, SECRETBOX_MACBYTES, 'mac', 'crypto_secretbox_MACBYTES');
    assertLength(n.length, SECRETBOX_NONCEBYTES, 'n', 'crypto_secretbox_NONCEBYTES');
    assertLength(k.length, SECRETBOX_KEYBYTES, 'k', 'crypto_secretbox_KEYBYTES');
    const sealed = secretboxSeal(m, n, k);
    c.set(sealed.ct);
    mac.set(sealed.mac);
    return undefined;
}

function crypto_secretbox_open_detached(args: IArguments): boolean {
    argv(args, 5, 'crypto_secretbox_open_detached');
    const m = typedArray(args[0], 'm');
    const c = typedArray(args[1], 'c');
    const mac = typedArray(args[2], 'mac');
    const n = typedArray(args[3], 'n');
    const k = typedArray(args[4], 'k');
    throws(m.length !== c.length, "m must be 'c.byteLength' bytes");
    assertLength(mac.length, SECRETBOX_MACBYTES, 'mac', 'crypto_secretbox_MACBYTES');
    assertLength(n.length, SECRETBOX_NONCEBYTES, 'n', 'crypto_secretbox_NONCEBYTES');
    assertLength(k.length, SECRETBOX_KEYBYTES, 'k', 'crypto_secretbox_KEYBYTES');
    return secretboxOpen(m, c, mac, n, k);
}

function crypto_box_keypair(args: IArguments): undefined {
    argv(args, 2, 'crypto_box_keypair');
    const pk = typedArray(args[0], 'pk');
    const sk = typedArray(args[1], 'sk');
    assertLength(pk.length, BOX_PUBLICKEYBYTES, 'pk', 'crypto_box_PUBLICKEYBYTES');
    assertLength(sk.length, BOX_SECRETKEYBYTES, 'sk', 'crypto_box_SECRETKEYBYTES');
    const seed = randomValues(BOX_SECRETKEYBYTES);
    sk.set(seed);
    pk.set(x25519.scalarMultBase(seed));
    return undefined;
}

function crypto_box_seed_keypair(args: IArguments): undefined {
    argv(args, 3, 'crypto_box_seed_keypair');
    const pk = typedArray(args[0], 'pk');
    const sk = typedArray(args[1], 'sk');
    const seed = typedArray(args[2], 'seed');
    assertLength(pk.length, BOX_PUBLICKEYBYTES, 'pk', 'crypto_box_PUBLICKEYBYTES');
    assertLength(sk.length, BOX_SECRETKEYBYTES, 'sk', 'crypto_box_SECRETKEYBYTES');
    assertLength(seed.length, BOX_SEEDBYTES, 'seed', 'crypto_box_SEEDBYTES');
    // The secret key is SHA-512(seed)[0..32), not the seed: measured against the real add-on.
    sk.set(sha512(seed).subarray(0, BOX_SECRETKEYBYTES));
    pk.set(x25519.scalarMultBase(sk));
    return undefined;
}

function crypto_box_easy(args: IArguments): undefined {
    argv(args, 5, 'crypto_box_easy');
    const c = typedArray(args[0], 'c');
    const m = typedArray(args[1], 'm');
    const n = typedArray(args[2], 'n');
    const pk = typedArray(args[3], 'pk');
    const sk = typedArray(args[4], 'sk');
    throws(c.length !== m.length + BOX_MACBYTES, "c must be 'm.byteLength + crypto_box_MACBYTES' bytes");
    assertLength(n.length, BOX_NONCEBYTES, 'n', 'crypto_box_NONCEBYTES');
    assertLength(sk.length, BOX_SECRETKEYBYTES, 'sk', 'crypto_box_SECRETKEYBYTES');
    assertLength(pk.length, BOX_PUBLICKEYBYTES, 'pk', 'crypto_box_PUBLICKEYBYTES');
    const { ct, mac } = secretboxSeal(m, n, beforenm(pk, sk));
    c.set(mac, 0);
    c.set(ct, BOX_MACBYTES);
    return undefined;
}

function crypto_box_open_easy(args: IArguments): boolean {
    argv(args, 5, 'crypto_box_open_easy');
    const m = typedArray(args[0], 'm');
    const c = typedArray(args[1], 'c');
    const n = typedArray(args[2], 'n');
    const pk = typedArray(args[3], 'pk');
    const sk = typedArray(args[4], 'sk');
    throws(m.length !== c.length - BOX_MACBYTES, "m must be 'c.byteLength - crypto_box_MACBYTES' bytes");
    assertMinLength(c.length, BOX_MACBYTES, 'c', 'crypto_box_MACBYTES');
    assertLength(n.length, BOX_NONCEBYTES, 'n', 'crypto_box_NONCEBYTES');
    assertLength(sk.length, BOX_SECRETKEYBYTES, 'sk', 'crypto_box_SECRETKEYBYTES');
    assertLength(pk.length, BOX_PUBLICKEYBYTES, 'pk', 'crypto_box_PUBLICKEYBYTES');
    return secretboxOpen(m, c.subarray(BOX_MACBYTES), c.subarray(0, BOX_MACBYTES), n, beforenm(pk, sk));
}

function crypto_box_detached(args: IArguments): undefined {
    argv(args, 6, 'crypto_box_detached');
    const c = typedArray(args[0], 'c');
    const mac = typedArray(args[1], 'mac');
    const m = typedArray(args[2], 'm');
    const n = typedArray(args[3], 'n');
    const pk = typedArray(args[4], 'pk');
    const sk = typedArray(args[5], 'sk');
    throws(c.length !== m.length, "c must be 'm.byteLength' bytes");
    assertLength(mac.length, BOX_MACBYTES, 'mac', 'crypto_box_MACBYTES');
    assertLength(n.length, BOX_NONCEBYTES, 'n', 'crypto_box_NONCEBYTES');
    assertLength(sk.length, BOX_SECRETKEYBYTES, 'sk', 'crypto_box_SECRETKEYBYTES');
    assertLength(pk.length, BOX_PUBLICKEYBYTES, 'pk', 'crypto_box_PUBLICKEYBYTES');
    const sealed = secretboxSeal(m, n, beforenm(pk, sk));
    c.set(sealed.ct);
    mac.set(sealed.mac);
    return undefined;
}

function crypto_box_open_detached(args: IArguments): boolean {
    argv(args, 6, 'crypto_box_open_detached');
    const m = typedArray(args[0], 'm');
    const c = typedArray(args[1], 'c');
    const mac = typedArray(args[2], 'mac');
    const n = typedArray(args[3], 'n');
    const pk = typedArray(args[4], 'pk');
    const sk = typedArray(args[5], 'sk');
    throws(m.length !== c.length, "m must be 'c.byteLength' bytes");
    assertLength(mac.length, BOX_MACBYTES, 'mac', 'crypto_box_MACBYTES');
    assertLength(n.length, BOX_NONCEBYTES, 'n', 'crypto_box_NONCEBYTES');
    assertLength(sk.length, BOX_SECRETKEYBYTES, 'sk', 'crypto_box_SECRETKEYBYTES');
    assertLength(pk.length, BOX_PUBLICKEYBYTES, 'pk', 'crypto_box_PUBLICKEYBYTES');
    return secretboxOpen(m, c, mac, n, beforenm(pk, sk));
}

function crypto_sign_keypair(args: IArguments): undefined {
    argv(args, 2, 'crypto_sign_keypair');
    const pk = typedArray(args[0], 'pk');
    const sk = typedArray(args[1], 'sk');
    assertLength(pk.length, SIGN_PUBLICKEYBYTES, 'pk', 'crypto_sign_PUBLICKEYBYTES');
    assertLength(sk.length, SIGN_SECRETKEYBYTES, 'sk', 'crypto_sign_SECRETKEYBYTES');
    const seed = randomValues(SIGN_SEEDBYTES);
    sk.set(seed, 0);
    sk.set(ed25519.getPublicKey(seed), SIGN_SEEDBYTES);
    pk.set(sk.subarray(SIGN_SEEDBYTES));
    return undefined;
}

function crypto_sign_seed_keypair(args: IArguments): undefined {
    argv(args, 3, 'crypto_sign_seed_keypair');
    const pk = typedArray(args[0], 'pk');
    const sk = typedArray(args[1], 'sk');
    const seed = typedArray(args[2], 'seed');
    assertLength(pk.length, SIGN_PUBLICKEYBYTES, 'pk', 'crypto_sign_PUBLICKEYBYTES');
    assertLength(sk.length, SIGN_SECRETKEYBYTES, 'sk', 'crypto_sign_SECRETKEYBYTES');
    assertLength(seed.length, SIGN_SEEDBYTES, 'seed', 'crypto_sign_SEEDBYTES');
    sk.set(seed, 0);
    sk.set(ed25519.getPublicKey(seed), SIGN_SEEDBYTES);
    pk.set(sk.subarray(SIGN_SEEDBYTES));
    return undefined;
}

function crypto_sign_detached(args: IArguments): undefined {
    argv(args, 3, 'crypto_sign_detached');
    const sig = typedArray(args[0], 'sig');
    const m = typedArray(args[1], 'm');
    const sk = typedArray(args[2], 'sk');
    assertLength(sig.length, SIGN_BYTES, 'sm', 'crypto_sign_BYTES');
    assertLength(sk.length, SIGN_SECRETKEYBYTES, 'sk', 'crypto_sign_SECRETKEYBYTES');
    sig.set(ed25519.sign(m, sk.subarray(0, SIGN_SEEDBYTES)));
    return undefined;
}

function crypto_sign_verify_detached(args: IArguments): boolean {
    argv(args, 3, 'crypto_sign_verify_detached');
    const sig = typedArray(args[0], 'sig');
    const m = typedArray(args[1], 'm');
    const pk = typedArray(args[2], 'pk');
    assertMinLength(sig.length, SIGN_BYTES, 'sig', 'crypto_sign_BYTES');
    assertLength(pk.length, SIGN_PUBLICKEYBYTES, 'pk', 'crypto_sign_PUBLICKEYBYTES');
    // The add-on reports a malformed signature as false, which noble would report by throwing.
    try {
        return ed25519.verify(sig.subarray(0, SIGN_BYTES), m, pk);
    } catch {
        return false;
    }
}

function crypto_sign_ed25519_sk_to_pk(args: IArguments): undefined {
    argv(args, 2, 'crypto_sign_ed25519_sk_to_pk');
    const pk = typedArray(args[0], 'pk');
    const sk = typedArray(args[1], 'sk');
    assertLength(pk.length, SIGN_PUBLICKEYBYTES, 'pk', 'crypto_sign_PUBLICKEYBYTES');
    assertLength(sk.length, SIGN_SECRETKEYBYTES, 'sk', 'crypto_sign_SECRETKEYBYTES');
    pk.set(ed25519.getPublicKey(sk.subarray(0, SIGN_SEEDBYTES)));
    return undefined;
}

function crypto_sign_ed25519_pk_to_curve25519(args: IArguments): undefined {
    argv(args, 2, 'crypto_sign_ed25519_pk_to_curve25519');
    const x25519Pk = typedArray(args[0], 'x25519_pk');
    const ed25519Pk = typedArray(args[1], 'ed25519_pk');
    assertLength(x25519Pk.length, BOX_PUBLICKEYBYTES, 'x25519_pk', 'crypto_box_PUBLICKEYBYTES');
    assertLength(ed25519Pk.length, SIGN_PUBLICKEYBYTES, 'ed25519_pk', 'crypto_sign_PUBLICKEYBYTES');
    x25519Pk.set(edwardsToMontgomeryPub(ed25519Pk));
    return undefined;
}

function crypto_sign_ed25519_sk_to_curve25519(args: IArguments): undefined {
    argv(args, 2, 'crypto_sign_ed25519_sk_to_curve25519');
    const x25519Sk = typedArray(args[0], 'x25519_sk');
    const ed25519Sk = typedArray(args[1], 'ed25519_sk');
    assertLength(x25519Sk.length, BOX_SECRETKEYBYTES, 'x25519_sk', 'crypto_box_SECRETKEYBYTES');
    throws(
        ed25519Sk.length !== SIGN_SECRETKEYBYTES && ed25519Sk.length !== SIGN_PUBLICKEYBYTES,
        "ed25519_sk should either be 'crypto_sign_SECRETKEYBYTES' bytes or 'crypto_sign_SECRETKEYBYTES - crypto_sign_PUBLICKEYBYTES' bytes"
    );
    x25519Sk.set(edwardsToMontgomeryPriv(ed25519Sk.subarray(0, SIGN_SEEDBYTES)));
    return undefined;
}

function crypto_generichash(args: IArguments): undefined {
    // Two arguments hash without a key; a third that is absent is not the same as one that is empty,
    // which the binding reads as a NULL key and rejects with Error('key').
    argvOpts(args, 2, 'crypto_generichash');
    const out = typedArray(args[0], 'out');
    const input = typedArray(args[1], 'in');
    assertMinLength(out.length, GENERICHASH_BYTES_MIN, 'out', 'crypto_generichash_BYTES_MIN');
    assertMaxLength(out.length, GENERICHASH_BYTES_MAX, 'out', 'crypto_generichash_BYTES_MAX');
    const key = args.length > 2 ? typedArray(args[2], 'key') : optionalTypedArray(undefined, 'key');
    // A zero-length key hashes without one, which is what libsodium does with a NULL key; the wrapper in
    // sodium-native 5 passes an empty key when the caller gives none.
    if (args.length > 2 && key.length !== 0) {
        throws(key.length < GENERICHASH_KEYBYTES_MIN, 'key');
        assertMaxLength(key.length, GENERICHASH_KEYBYTES_MAX, 'key', 'crypto_generichash_KEYBYTES_MAX');
    }
    out.set(generichash(input, key, out.length).subarray(0, out.length));
    return undefined;
}

function crypto_generichash_keygen(args: IArguments): undefined {
    argv(args, 1, 'crypto_generichash_keygen');
    const key = typedArray(args[0], 'key');
    assertLength(key.length, GENERICHASH_KEYBYTES, 'key', 'crypto_generichash_KEYBYTES');
    key.set(randomValues(GENERICHASH_KEYBYTES));
    return undefined;
}

function crypto_hash(args: IArguments): undefined {
    argv(args, 2, 'crypto_hash_sha256');
    const out = typedArray(args[0], 'out');
    const input = typedArray(args[1], 'in');
    assertLength(out.length, HASH_BYTES, 'out', 'crypto_hash_BYTES');
    out.set(sha512(input));
    return undefined;
}

function crypto_hash_sha256(args: IArguments): undefined {
    argv(args, 2, 'crypto_hash_sha256');
    const out = typedArray(args[0], 'out');
    const input = typedArray(args[1], 'in');
    assertLength(out.length, HASH_SHA256_BYTES, 'out', 'crypto_hash_sha256_BYTES');
    out.set(sha256(input));
    return undefined;
}

function crypto_hash_sha512(args: IArguments): undefined {
    argv(args, 2, 'crypto_hash_sha512');
    const out = typedArray(args[0], 'out');
    const input = typedArray(args[1], 'in');
    assertLength(out.length, HASH_SHA512_BYTES, 'out', 'crypto_hash_sha512_BYTES');
    out.set(sha512(input));
    return undefined;
}

function crypto_auth(args: IArguments): undefined {
    argv(args, 3, 'crypto_auth');
    const out = typedArray(args[0], 'out');
    const input = typedArray(args[1], 'in');
    const k = typedArray(args[2], 'k');
    assertLength(out.length, AUTH_BYTES, 'out', 'crypto_auth_BYTES');
    assertLength(k.length, AUTH_KEYBYTES, 'k', 'crypto_auth_KEYBYTES');
    out.set(auth(input, k));
    return undefined;
}

function crypto_auth_verify(args: IArguments): boolean {
    argv(args, 3, 'crypto_auth_verify');
    const h = typedArray(args[0], 'h');
    const input = typedArray(args[1], 'in');
    const k = typedArray(args[2], 'k');
    assertLength(h.length, AUTH_BYTES, 'h', 'crypto_auth_BYTES');
    assertLength(k.length, AUTH_KEYBYTES, 'k', 'crypto_auth_KEYBYTES');
    return constantTimeEqual(auth(input, k), h);
}

function crypto_scalarmult(args: IArguments): undefined {
    argv(args, 3, 'crypto_scalarmult');
    const q = typedArray(args[0], 'q');
    const n = typedArray(args[1], 'n');
    const p = typedArray(args[2], 'p');
    assertLength(q.length, SCALARMULT_BYTES, 'q', 'crypto_scalarmult_BYTES');
    assertLength(n.length, SCALARMULT_SCALARBYTES, 'n', 'crypto_scalarmult_SCALARBYTES');
    assertLength(p.length, SCALARMULT_BYTES, 'p', 'crypto_scalarmult_BYTES');
    q.set(x25519.scalarMult(n, p));
    return undefined;
}

function crypto_scalarmult_base(args: IArguments): undefined {
    argv(args, 2, 'crypto_scalarmult_base');
    const q = typedArray(args[0], 'q');
    const n = typedArray(args[1], 'n');
    assertLength(q.length, SCALARMULT_BYTES, 'q', 'crypto_scalarmult_BYTES');
    assertLength(n.length, SCALARMULT_SCALARBYTES, 'n', 'crypto_scalarmult_SCALARBYTES');
    q.set(x25519.scalarMultBase(n));
    return undefined;
}

function crypto_onetimeauth(args: IArguments): undefined {
    argv(args, 3, 'crypto_onetimeauth');
    const out = typedArray(args[0], 'out');
    const input = typedArray(args[1], 'in');
    const k = typedArray(args[2], 'k');
    assertLength(out.length, ONETIMEAUTH_BYTES, 'out', 'crypto_onetimeauth_BYTES');
    assertLength(k.length, ONETIMEAUTH_KEYBYTES, 'k', 'crypto_onetimeauth_KEYBYTES');
    out.set(onetimeauth(input, k));
    return undefined;
}

function crypto_onetimeauth_verify(args: IArguments): boolean {
    argv(args, 3, 'crypto_onetimeauth_verify');
    const h = typedArray(args[0], 'h');
    const input = typedArray(args[1], 'in');
    const k = typedArray(args[2], 'k');
    assertLength(h.length, ONETIMEAUTH_BYTES, 'h', 'crypto_onetimeauth_BYTES');
    assertLength(k.length, ONETIMEAUTH_KEYBYTES, 'k', 'crypto_onetimeauth_KEYBYTES');
    return constantTimeEqual(onetimeauth(input, k), h);
}

/** An additional-data argument the binding accepts as null, which hashes as absent. */
function adArg(value: unknown): Uint8Array {
    return value === null || value === undefined ? new Uint8Array(0) : typedArray(value, 'ad');
}

/** The nsec argument, which libsodium ignores and the binding insists is null. */
function nsecArg(value: unknown): void {
    throws(value !== null && value !== undefined, 'nsec must always be set to null');
}

function aeadEncrypt(name: string, kind: AeadKind, abytes: number, npubBytes: number, npubName: string) {
    return function (args: IArguments): number {
        argv(args, 6, name);
        const c = typedArray(args[0], 'c');
        const m = typedArray(args[1], 'm');
        const ad = adArg(args[2]);
        nsecArg(args[3]);
        const npub = typedArray(args[4], 'npub');
        const k = typedArray(args[5], 'k');
        throws(c.length !== m.length + abytes, "c must 'm.byteLength + " + abytesConstantName(abytes) + "' bytes");
        throws(c.length > 0xffffffff, 'c.byteLength must be a 32bit integer');
        assertLength(npub.length, npubBytes, 'npub', npubName);
        assertLength(k.length, AEAD_KEYBYTES, 'k', 'crypto_aead_' + kind + '_ietf_KEYBYTES');
        c.set(aeadSeal(kind, m, ad, npub, k));
        return c.length;
    };
}

function abytesConstantName(abytes: number): string {
    return abytes === 16 ? 'crypto_aead_chacha20poly1305_ietf_ABYTES' : 'crypto_aead_xchacha20poly1305_ietf_ABYTES';
}

function aeadDecrypt(name: string, kind: AeadKind, abytes: number, npubBytes: number, npubName: string) {
    return function (args: IArguments): number {
        argv(args, 6, name);
        const m = typedArray(args[0], 'm');
        nsecArg(args[1]);
        const c = typedArray(args[2], 'c');
        const ad = adArg(args[3]);
        const npub = typedArray(args[4], 'npub');
        const k = typedArray(args[5], 'k');
        throws(m.length !== c.length - abytes, "m must 'c.byteLength - " + abytesConstantName(abytes) + "' bytes");
        assertLength(npub.length, npubBytes, 'npub', npubName);
        assertLength(k.length, AEAD_KEYBYTES, 'k', 'crypto_aead_' + kind + '_ietf_KEYBYTES');
        throws(m.length > 0xffffffff, 'm.byteLength must be a 32bit integer');
        let opened: Uint8Array;
        try {
            opened = aeadOpen(kind, c, ad, npub, k);
        } catch {
            throw new Error('could not verify data');
        }
        m.set(opened);
        return m.length;
    };
}

function aeadEncryptDetached(name: string, kind: AeadKind, npubBytes: number, npubName: string) {
    return function (args: IArguments): number {
        argv(args, 7, name);
        const c = typedArray(args[0], 'c');
        const mac = typedArray(args[1], 'mac');
        const m = typedArray(args[2], 'm');
        const ad = adArg(args[3]);
        nsecArg(args[4]);
        const npub = typedArray(args[5], 'npub');
        const k = typedArray(args[6], 'k');
        throws(c.length !== m.length, "c must be 'm.byteLength' bytes");
        assertLength(mac.length, 16, 'mac', abytesConstantName(16));
        assertLength(npub.length, npubBytes, 'npub', npubName);
        assertLength(k.length, AEAD_KEYBYTES, 'k', 'crypto_aead_' + kind + '_ietf_KEYBYTES');
        const sealed = aeadSeal(kind, m, ad, npub, k);
        c.set(sealed.subarray(0, m.length));
        mac.set(sealed.subarray(m.length));
        return mac.length;
    };
}

function aeadDecryptDetached(name: string, kind: AeadKind, npubBytes: number, npubName: string) {
    return function (args: IArguments): undefined {
        argv(args, 7, name);
        const m = typedArray(args[0], 'm');
        nsecArg(args[1]);
        const c = typedArray(args[2], 'c');
        const mac = typedArray(args[3], 'mac');
        const ad = adArg(args[4]);
        const npub = typedArray(args[5], 'npub');
        const k = typedArray(args[6], 'k');
        throws(m.length !== c.length, "m must be 'c.byteLength' bytes");
        assertLength(mac.length, 16, 'mac', abytesConstantName(16));
        assertLength(npub.length, npubBytes, 'npub', npubName);
        assertLength(k.length, AEAD_KEYBYTES, 'k', 'crypto_aead_' + kind + '_ietf_KEYBYTES');
        let opened: Uint8Array;
        try {
            const joined = new Uint8Array(c.length + mac.length);
            joined.set(c, 0);
            joined.set(mac, c.length);
            opened = aeadOpen(kind, joined, ad, npub, k);
        } catch {
            throw new Error('could not verify data');
        }
        m.set(opened);
        return undefined;
    };
}

function aeadKeygen(name: string) {
    return function (args: IArguments): undefined {
        argv(args, 1, name);
        const k = typedArray(args[0], 'k');
        assertLength(k.length, AEAD_KEYBYTES, 'k', 'crypto_aead_chacha20poly1305_ietf_KEYBYTES');
        k.set(randomValues(AEAD_KEYBYTES));
        return undefined;
    };
}

function crypto_stream_chacha20_ietf_xor(args: IArguments): undefined {
    argv(args, 4, 'crypto_stream_chacha20_ietf_xor');
    const c = typedArray(args[0], 'c');
    const m = typedArray(args[1], 'm');
    const n = typedArray(args[2], 'n');
    const k = typedArray(args[3], 'k');
    throws(c.length !== m.length, "m must be 'c.byteLength' bytes");
    assertLength(n.length, CHACHA20_IETF_NONCEBYTES, 'n', 'crypto_stream_chacha20_ietf_NONCEBYTES');
    assertLength(k.length, CHACHA20_IETF_KEYBYTES, 'k', 'crypto_stream_chacha20_ietf_KEYBYTES');
    c.set(chacha20(k, n, m, undefined, 0));
    return undefined;
}

function crypto_stream_chacha20_ietf_xor_ic(args: IArguments): undefined {
    argv(args, 5, 'crypto_stream_chacha20_ietf_xor_ic');
    const c = typedArray(args[0], 'c');
    const m = typedArray(args[1], 'm');
    const n = typedArray(args[2], 'n');
    const ic = uint32(args[3], 'ic');
    const k = typedArray(args[4], 'k');
    throws(c.length !== m.length, "m must be 'c.byteLength' bytes");
    assertLength(n.length, CHACHA20_IETF_NONCEBYTES, 'n', 'crypto_stream_chacha20_ietf_NONCEBYTES');
    assertLength(k.length, CHACHA20_IETF_KEYBYTES, 'k', 'crypto_stream_chacha20_ietf_KEYBYTES');
    c.set(chacha20(k, n, m, undefined, ic));
    return undefined;
}

function crypto_kdf_derive_from_key(args: IArguments): undefined {
    argv(args, 4, 'crypto_kdf_derive_from_key');
    const subkey = typedArray(args[0], 'subkey');
    const subkeyId = args[1];
    const ctx = typedArray(args[2], 'ctx');
    const key = typedArray(args[3], 'key');
    assertMinLength(subkey.length, KDF_BYTES_MIN, 'subkey', 'crypto_kdf_BYTES_MIN');
    assertMaxLength(subkey.length, KDF_BYTES_MAX, 'subkey', 'crypto_kdf_BYTES_MAX');
    assertLength(ctx.length, KDF_CONTEXTBYTES, 'ctx', 'crypto_kdf_CONTEXTBYTES');
    assertLength(key.length, KDF_KEYBYTES, 'key', 'crypto_kdf_KEYBYTES');
    if (typeof subkeyId !== 'number' && typeof subkeyId !== 'bigint') {
        throw new TypeError('subkey_id must be an instance of Number');
    }
    subkey.set(kdfDerive(subkey.length, subkeyId as number | bigint, ctx, key).subarray(0, subkey.length));
    return undefined;
}

function crypto_kdf_keygen(args: IArguments): undefined {
    argv(args, 1, 'crypto_kdf_keygen');
    const key = typedArray(args[0], 'key');
    assertLength(key.length, KDF_KEYBYTES, 'key', 'crypto_kdf_KEYBYTES');
    key.set(randomValues(KDF_KEYBYTES));
    return undefined;
}

function crypto_kx_keypair(args: IArguments): undefined {
    argv(args, 2, 'crypto_kx_keypair');
    const pk = typedArray(args[0], 'pk');
    const sk = typedArray(args[1], 'sk');
    assertLength(pk.length, KX_PUBLICKEYBYTES, 'pk', 'crypto_kx_PUBLICKEYBYTES');
    assertLength(sk.length, KX_SECRETKEYBYTES, 'sk', 'crypto_kx_SECRETKEYBYTES');
    const seed = randomValues(KX_SECRETKEYBYTES);
    sk.set(seed);
    pk.set(x25519.scalarMultBase(seed));
    return undefined;
}

function crypto_kx_seed_keypair(args: IArguments): undefined {
    argv(args, 3, 'crypto_kx_seed_keypair');
    const pk = typedArray(args[0], 'pk');
    const sk = typedArray(args[1], 'sk');
    const seed = typedArray(args[2], 'seed');
    assertLength(pk.length, KX_PUBLICKEYBYTES, 'pk', 'crypto_kx_PUBLICKEYBYTES');
    assertLength(sk.length, KX_SECRETKEYBYTES, 'sk', 'crypto_kx_SECRETKEYBYTES');
    assertLength(seed.length, KX_SEEDBYTES, 'seed', 'crypto_kx_SEEDBYTES');
    kxSeedKeypair(pk, sk, seed);
    return undefined;
}

/** crypto_kx_*_session_keys: `server` decides which half each side transmits and which it receives. */
function kxSessionKeysBinding(name: string, server: boolean) {
    return function (args: IArguments): undefined {
        argv(args, 5, name);
        const rx = args[0] === null || args[0] === undefined ? null : typedArray(args[0], 'rx');
        const tx = args[1] === null || args[1] === undefined ? null : typedArray(args[1], 'tx');
        throws(rx === null && tx === null, 'at least one session key must be specified');
        const myPk = typedArray(args[2], server ? 'server_pk' : 'client_pk');
        const mySk = typedArray(args[3], server ? 'server_sk' : 'client_sk');
        const theirPk = typedArray(args[4], server ? 'client_pk' : 'server_pk');
        assertLength(myPk.length, KX_PUBLICKEYBYTES, server ? 'server_pk' : 'client_pk', 'crypto_kx_PUBLICKEYBYTES');
        assertLength(mySk.length, KX_SECRETKEYBYTES, server ? 'server_sk' : 'client_sk', 'crypto_kx_SECRETKEYBYTES');
        assertLength(theirPk.length, KX_PUBLICKEYBYTES, server ? 'client_pk' : 'server_pk', 'crypto_kx_PUBLICKEYBYTES');
        throws(tx !== null && tx.length !== KX_SESSIONKEYBYTES, "transmitting key buffer must be 'crypto_kx_SESSIONKEYBYTES' bytes or null");
        throws(rx !== null && rx.length !== KX_SESSIONKEYBYTES, "receiving key buffer must be 'crypto_kx_SESSIONKEYBYTES' bytes or null");
        const clientPk = server ? theirPk : myPk;
        const serverPk = server ? myPk : theirPk;
        const q = x25519.scalarMult(mySk, theirPk);
        const keys = kxSessionKeys(q, clientPk, serverPk);
        const first = keys.subarray(0, KX_SESSIONKEYBYTES);
        const second = keys.subarray(KX_SESSIONKEYBYTES);
        // libsodium aliases the missing buffer onto the present one (if (rx == NULL) rx = tx; if
        // (tx == NULL) tx = rx;) and then writes rx first and tx second, so the buffer that is
        // present ends up holding the SECOND key - the one it would not have got with both given.
        if (rx !== null) rx.set(server ? second : first);
        if (tx !== null) tx.set(server ? first : second);
        if (rx === null && tx !== null) tx.set(second);
        if (tx === null && rx !== null) rx.set(second);
        return undefined;
    };
}

/** The bindings the shim computes, by export name. */
const IMPLEMENTED: Readonly<Record<string, (args: IArguments) => unknown>> = {
    crypto_aead_chacha20poly1305_ietf_decrypt: aeadDecrypt(
        'crypto_aead_chacha20poly1305_ietf_decrypt', 'chacha20poly1305', 16, AEAD_CHACHA_NPUBBYTES,
        'crypto_aead_chacha20poly1305_ietf_NPUBBYTES'
    ),
    crypto_aead_chacha20poly1305_ietf_decrypt_detached: aeadDecryptDetached(
        'crypto_aead_chacha20poly1305_ietf_decrypt_detached', 'chacha20poly1305', AEAD_CHACHA_NPUBBYTES,
        'crypto_aead_chacha20poly1305_ietf_NPUBBYTES'
    ),
    crypto_aead_chacha20poly1305_ietf_encrypt: aeadEncrypt(
        'crypto_aead_chacha20poly1305_ietf_encrypt', 'chacha20poly1305', 16, AEAD_CHACHA_NPUBBYTES,
        'crypto_aead_chacha20poly1305_ietf_NPUBBYTES'
    ),
    crypto_aead_chacha20poly1305_ietf_encrypt_detached: aeadEncryptDetached(
        'crypto_aead_chacha20poly1305_ietf_encrypt_detached', 'chacha20poly1305', AEAD_CHACHA_NPUBBYTES,
        'crypto_aead_chacha20poly1305_ietf_NPUBBYTES'
    ),
    crypto_aead_chacha20poly1305_ietf_keygen: aeadKeygen('crypto_aead_chacha20poly1305_ietf_keygen'),
    crypto_aead_xchacha20poly1305_ietf_decrypt: aeadDecrypt(
        'crypto_aead_xchacha20poly1305_ietf_decrypt', 'xchacha20poly1305', 16, AEAD_XCHACHA_NPUBBYTES,
        'crypto_aead_xchacha20poly1305_ietf_NPUBBYTES'
    ),
    crypto_aead_xchacha20poly1305_ietf_decrypt_detached: aeadDecryptDetached(
        'crypto_aead_xchacha20poly1305_ietf_decrypt_detached', 'xchacha20poly1305', AEAD_XCHACHA_NPUBBYTES,
        'crypto_aead_xchacha20poly1305_ietf_NPUBBYTES'
    ),
    crypto_aead_xchacha20poly1305_ietf_encrypt: aeadEncrypt(
        'crypto_aead_xchacha20poly1305_ietf_encrypt', 'xchacha20poly1305', 16, AEAD_XCHACHA_NPUBBYTES,
        'crypto_aead_xchacha20poly1305_ietf_NPUBBYTES'
    ),
    crypto_aead_xchacha20poly1305_ietf_encrypt_detached: aeadEncryptDetached(
        'crypto_aead_xchacha20poly1305_ietf_encrypt_detached', 'xchacha20poly1305', AEAD_XCHACHA_NPUBBYTES,
        'crypto_aead_xchacha20poly1305_ietf_NPUBBYTES'
    ),
    crypto_aead_xchacha20poly1305_ietf_keygen: aeadKeygen('crypto_aead_xchacha20poly1305_ietf_keygen'),
    crypto_auth,
    crypto_auth_verify,
    crypto_box_easy,
    crypto_box_detached,
    crypto_box_keypair,
    crypto_box_open_detached,
    crypto_box_open_easy,
    crypto_box_seed_keypair,
    crypto_generichash,
    crypto_generichash_keygen,
    crypto_hash,
    crypto_hash_sha256,
    crypto_hash_sha512,
    crypto_kdf_derive_from_key,
    crypto_kdf_keygen,
    crypto_kx_client_session_keys: kxSessionKeysBinding('crypto_kx_client_session_keys', false),
    crypto_kx_keypair,
    crypto_kx_seed_keypair,
    crypto_kx_server_session_keys: kxSessionKeysBinding('crypto_kx_server_session_keys', true),
    crypto_onetimeauth,
    crypto_onetimeauth_verify,
    crypto_scalarmult,
    crypto_scalarmult_base,
    crypto_secretbox_detached,
    crypto_secretbox_easy,
    crypto_secretbox_open_detached,
    crypto_secretbox_open_easy,
    crypto_sign_detached,
    crypto_sign_ed25519_pk_to_curve25519,
    crypto_sign_ed25519_sk_to_curve25519,
    crypto_sign_ed25519_sk_to_pk,
    crypto_sign_keypair,
    crypto_sign_seed_keypair,
    crypto_sign_verify_detached,
    crypto_stream_chacha20_ietf_xor,
    crypto_stream_chacha20_ietf_xor_ic,
    randombytes_buf,
    randombytes_buf_deterministic,
    randombytes_random,
    randombytes_uniform,
    sodium_add,
    sodium_compare,
    sodium_increment,
    sodium_is_zero,
    sodium_memcmp,
    sodium_memzero,
    sodium_sub,
    sodium_malloc,
    sodium_free,
    sodium_mprotect_noaccess: sodiumMprotect('sodium_mprotect_noaccess'),
    sodium_mprotect_readonly: sodiumMprotect('sodium_mprotect_readonly'),
    sodium_mprotect_readwrite: sodiumMprotect('sodium_mprotect_readwrite'),
    sodium_mlock,
    sodium_munlock
};

/** Why the add-on's remaining functions are not computed here. */
const UNSUPPORTED_REASONS: Readonly<Record<string, string>> = {
    crypto_pwhash: 'Argon2 needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_async: 'Argon2 needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_str: 'Argon2 needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_str_async: 'Argon2 needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_str_needs_rehash: 'Argon2 needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_str_verify: 'Argon2 needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_str_verify_async: 'Argon2 needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_scryptsalsa208sha256: 'scrypt needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_scryptsalsa208sha256_async: 'scrypt needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_scryptsalsa208sha256_str: 'scrypt needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_scryptsalsa208sha256_str_async: 'scrypt needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_scryptsalsa208sha256_str_needs_rehash:
        'scrypt needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_scryptsalsa208sha256_str_verify:
        'scrypt needs a large memory-hard scratch area the guest cannot afford',
    crypto_pwhash_scryptsalsa208sha256_str_verify_async:
        'scrypt needs a large memory-hard scratch area the guest cannot afford',
    crypto_secretstream_xchacha20poly1305_init_push: 'streaming state is a native struct in a caller-owned buffer',
    crypto_secretstream_xchacha20poly1305_init_pull: 'streaming state is a native struct in a caller-owned buffer',
    crypto_secretstream_xchacha20poly1305_push: 'streaming state is a native struct in a caller-owned buffer',
    crypto_secretstream_xchacha20poly1305_pull: 'streaming state is a native struct in a caller-owned buffer',
    crypto_secretstream_xchacha20poly1305_rekey: 'streaming state is a native struct in a caller-owned buffer',
    crypto_generichash_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_generichash_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_generichash_final: 'streaming state is a native struct in a caller-owned buffer',
    crypto_hash_sha256_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_hash_sha256_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_hash_sha256_final: 'streaming state is a native struct in a caller-owned buffer',
    crypto_hash_sha512_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_hash_sha512_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_hash_sha512_final: 'streaming state is a native struct in a caller-owned buffer',
    crypto_onetimeauth_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_onetimeauth_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_onetimeauth_final: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_xor_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_xor_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_xor_final: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_chacha20_xor_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_chacha20_xor_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_chacha20_xor_final: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_chacha20_ietf_xor_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_chacha20_ietf_xor_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_chacha20_ietf_xor_final: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_xchacha20_xor_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_xchacha20_xor_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_xchacha20_xor_final: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_salsa20_xor_init: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_salsa20_xor_update: 'streaming state is a native struct in a caller-owned buffer',
    crypto_stream_salsa20_xor_final: 'streaming state is a native struct in a caller-owned buffer',
    sodium_pad: 'not part of the shimmed surface',
    sodium_unpad: 'not part of the shimmed surface'
};

/** The default reason for a binding with nothing special to say about it. */
const DEFAULT_UNSUPPORTED_REASON = 'not part of the shimmed surface';

export { UNSUPPORTED_CODE };

export function createAddon(): object {
    const addon: Record<string, unknown> = {};
    for (const name of SODIUM_CONSTANT_NAMES) addon[name] = SODIUM_CONSTANTS[name];
    for (const name of SODIUM_FUNCTION_NAMES) {
        const impl = IMPLEMENTED[name];
        addon[name] = impl
            ? napiFunction(impl, name)
            : napiFunction(() => {
                  throw unsupportedError(name, UNSUPPORTED_REASONS[name] || DEFAULT_UNSUPPORTED_REASON);
              });
    }
    return addon;
}
