import { hmac } from '@noble/hashes/hmac';
import { md5 } from '@noble/hashes/legacy';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha1 } from '@noble/hashes/sha1';
import { sha224, sha256 } from '@noble/hashes/sha256';
import { sha384, sha512 } from '@noble/hashes/sha512';
import { cbc, cfb, ctr, ecb, gcm } from '@noble/ciphers/aes';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { base64ToBytes, bytesToBase64 } from '../../../../../network/virtual/host-http';
import { CapabilityHandler } from './types';

/*
 * Host side of the guest's crypto hashing and ciphers. createHash, createHmac and pbkdf2Sync run on
 * the host's synchronous hash functions (@noble/hashes); createCipheriv and createDecipheriv keep
 * their state here as well, because @noble/ciphers lives on this side of the capability boundary.
 * synchronous hash functions (@noble/hashes), so a digest is one blocking capability call.
 * Bytes travel as base64 because capability arguments are JSON.
 */

type Digest = typeof sha256;

const DIGESTS: Record<string, Digest> = { md5, sha1, sha224, sha256, sha384, sha512 };

function digestFor(name: unknown): Digest {
    const digest = DIGESTS[String(name ?? '').toLowerCase()];
    if (digest === undefined) {
        throw Object.assign(new Error('Digest method not supported'), { code: 'ERR_OSSL_EVP_UNSUPPORTED' });
    }
    return digest;
}

const bytesArg = (value: unknown): Uint8Array => base64ToBytes(typeof value === 'string' ? value : '');

/* ---------------------------------------------------------------------------------------------
 * Ciphers: createCipheriv / createDecipheriv.
 *
 * The guest owns the object Node's callers see; the host owns the key, the chaining value and the
 * bytes buffered between calls, because @noble/ciphers is one-shot per cipher instance and lives
 * on this side of the capability boundary. ECB, CBC, CTR and CFB are emitted in the same chunk
 * sizes OpenSSL uses, so an incremental caller sees Node's byte counts. GCM and ChaCha20-Poly1305
 * cannot be resumed through @noble's one-shot entry points, so they emit at final() instead of at
 * update(); the concatenation of update() and final() is Node's either way.
 * ------------------------------------------------------------------------------------------ */

type CipherMode = 'ecb' | 'cbc' | 'ctr' | 'cfb' | 'gcm' | 'cc20p';

interface CipherSpec {
    mode: CipherMode;
    keyLength: number;
    /** 16 where OpenSSL emits a block at a time, 1 where it emits everything it is given. */
    blockSize: number;
    /** 0 for ECB, an exact length for the rest, -1 for GCM's variable nonce. */
    ivLength: number;
    aead: boolean;
}

const CIPHER_SPECS: Record<string, CipherSpec> = {};
for (const bits of [128, 192, 256]) {
    const keyLength = bits / 8;
    CIPHER_SPECS[`aes-${bits}-ecb`] = { mode: 'ecb', keyLength, blockSize: 16, ivLength: 0, aead: false };
    CIPHER_SPECS[`aes-${bits}-cbc`] = { mode: 'cbc', keyLength, blockSize: 16, ivLength: 16, aead: false };
    CIPHER_SPECS[`aes-${bits}-ctr`] = { mode: 'ctr', keyLength, blockSize: 1, ivLength: 16, aead: false };
    CIPHER_SPECS[`aes-${bits}-cfb`] = { mode: 'cfb', keyLength, blockSize: 1, ivLength: 16, aead: false };
    CIPHER_SPECS[`aes-${bits}-gcm`] = { mode: 'gcm', keyLength, blockSize: 1, ivLength: -1, aead: true };
}
CIPHER_SPECS['chacha20-poly1305'] = { mode: 'cc20p', keyLength: 32, blockSize: 1, ivLength: 12, aead: true };

/** GCM accepts a nonce of almost any length in Node; @noble draws the line at 8 bytes. */
const GCM_MIN_IV = 8;
const TAG_LENGTH = 16;
const BLOCK = 16;
/** A cipher a process abandoned without calling final() is dropped rather than kept forever. */
const OPEN_CIPHER_LIMIT = 256;

interface CipherState {
    spec: CipherSpec;
    direction: 'encrypt' | 'decrypt';
    key: Uint8Array;
    /** CBC and CFB chaining value, CTR counter block, or the AEAD nonce. */
    iv: Uint8Array;
    /** CTR only: how many bytes of the current counter block are already spent. */
    counterOffset: number;
    /** CFB only: the ciphertext of the block being filled, and E(register) while it is open. */
    chainBuf: Uint8Array;
    keystream: Uint8Array | null;
    pending: Uint8Array;
    autoPadding: boolean;
    /** Whether any data has been through update(): AAD cannot be set after it has. */
    updated: boolean;
    aad: Uint8Array;
    tag?: Uint8Array;
}

const CIPHER_STATE = new Map<number, CipherState>();
let nextCipherId = 1;

/**
 * Node distinguishes these by constructor, and the capability envelope carries a code and a message
 * but not a class, so the class travels as a property the guest rebuilds from. `code: null` marks an
 * error Node raises without a code at all, such as a failed AEAD tag check.
 */
function cipherFail(code: string | null, message: string, kind: 'Error' | 'RangeError' | 'TypeError' = 'Error'): never {
    const Ctor = kind === 'RangeError' ? RangeError : kind === 'TypeError' ? TypeError : Error;
    throw Object.assign(new Ctor(message), { code: code ?? 'ERR_CAPABILITY', owcErrorClass: kind, owcUncoded: code === null });
}

const invalidKeyLength = () => cipherFail('ERR_CRYPTO_INVALID_KEYLEN', 'Invalid key length', 'RangeError');
const invalidIv = () => cipherFail('ERR_CRYPTO_INVALID_IV', 'Invalid initialization vector', 'TypeError');
const invalidState = (op: string) => cipherFail('ERR_CRYPTO_INVALID_STATE', `Invalid state for operation ${op}`);
const wrongFinalBlock = () => cipherFail('ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH', 'error:1C80006B:Provider routines::wrong final block length');
const badDecrypt = () => cipherFail('ERR_OSSL_BAD_DECRYPT', 'error:1C800064:Provider routines::bad decrypt');
const authFailure = () => cipherFail(null, 'Unsupported state or unable to authenticate data');

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Advances CTR's 16-byte big-endian counter by the blocks `consumed` bytes spanned. */
function advanceCounter(state: CipherState, consumed: number): void {
    let add = Math.floor(consumed / BLOCK);
    for (let i = BLOCK - 1; i >= 0 && add > 0; i--) {
        const sum = state.iv[i] + (add % 256);
        state.iv[i] = sum % 256;
        add = Math.floor(add / 256) + Math.floor(sum / 256);
    }
    state.counterOffset = consumed % BLOCK;
}

/** One pass over whole blocks, padding off: the caller pads, or holds a block back, itself. */
function transformBlocks(state: CipherState, bytes: Uint8Array): Uint8Array {
    const { spec, key } = state;
    const encrypt = state.direction === 'encrypt';
    if (bytes.length === 0) return new Uint8Array(0);
    switch (spec.mode) {
        case 'ecb': {
            const cipher = ecb(key, { disablePadding: true });
            return encrypt ? cipher.encrypt(bytes) : cipher.decrypt(bytes);
        }
        case 'cbc': {
            const cipher = cbc(key, state.iv, { disablePadding: true });
            const out = encrypt ? cipher.encrypt(bytes) : cipher.decrypt(bytes);
            if (out.length >= BLOCK) state.iv = (encrypt ? out : bytes).slice(-BLOCK);
            return out;
        }
        case 'cfb': {
            /*
             * CFB's keystream block is E(register), and the register becomes the ciphertext block
             * once one is complete, so a call that ends mid-block leaves the rest of that block for
             * the next call. Bytes are emitted as they arrive, as OpenSSL emits them.
             */
            const out = new Uint8Array(bytes.length);
            let at = 0;
            while (at < bytes.length) {
                if (state.keystream === null) state.keystream = aesBlock(state);
                const take = Math.min(BLOCK - state.counterOffset, bytes.length - at);
                for (let j = 0; j < take; j++) {
                    const produced = bytes[at + j] ^ state.keystream[state.counterOffset + j];
                    out[at + j] = produced;
                    state.chainBuf[state.counterOffset + j] = encrypt ? produced : bytes[at + j];
                }
                state.counterOffset += take;
                at += take;
                if (state.counterOffset === BLOCK) {
                    state.iv = state.chainBuf.slice(0, BLOCK);
                    state.counterOffset = 0;
                    state.keystream = null;
                }
            }
            return out;
        }
        default: {
            const blocks = Math.ceil((state.counterOffset + bytes.length) / BLOCK);
            const stream = ctr(key, state.iv).encrypt(new Uint8Array(blocks * BLOCK));
            const out = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ stream[state.counterOffset + i];
            advanceCounter(state, state.counterOffset + bytes.length);
            return out;
        }
    }
}

/** The raw AES block encryption of the current register or counter: ECB over one block, padding off. */
function aesBlock(state: CipherState): Uint8Array {
    return ecb(state.key, { disablePadding: true }).encrypt(state.iv);
}

function aeadCipher(state: CipherState) {
    const aad = state.aad.length > 0 ? state.aad : undefined;
    return state.spec.mode === 'gcm'
        ? gcm(state.key, state.iv, aad)
        : chacha20poly1305(state.key, state.iv, aad);
}

/** PKCS#7 removal: a padding byte outside 1..16, or a block that does not end in it, is a bad decrypt. */
function unpad(bytes: Uint8Array): Uint8Array {
    const pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > BLOCK || pad > bytes.length) throw badDecrypt();
    for (let i = bytes.length - pad; i < bytes.length; i++) if (bytes[i] !== pad) throw badDecrypt();
    return bytes.subarray(0, bytes.length - pad);
}

function cipherUpdate(state: CipherState, input: Uint8Array): Uint8Array {
    state.updated = true;
    if (state.spec.aead) {
        state.pending = concatBytes(state.pending, input);
        return new Uint8Array(0);
    }
    const total = concatBytes(state.pending, input);
    const block = state.spec.blockSize;
    let emit = Math.floor(total.length / block) * block;
    /* A decrypting block cipher with padding keeps its last whole block: it may hold the padding. */
    if (block === BLOCK && state.direction === 'decrypt' && state.autoPadding && total.length >= BLOCK && total.length % BLOCK === 0) {
        emit -= BLOCK;
    }
    const out = transformBlocks(state, total.subarray(0, emit));
    state.pending = total.subarray(emit);
    return out;
}

function cipherFinal(state: CipherState): { data: Uint8Array; tag?: Uint8Array } {
    const rest = state.pending;
    state.pending = new Uint8Array(0);
    if (state.spec.aead) {
        if (state.direction === 'encrypt') {
            const sealed = aeadCipher(state).encrypt(rest);
            return { data: sealed.subarray(0, sealed.length - TAG_LENGTH), tag: sealed.subarray(sealed.length - TAG_LENGTH) };
        }
        if (state.tag === undefined) throw authFailure();
        try {
            return { data: aeadCipher(state).decrypt(concatBytes(rest, state.tag)) };
        } catch {
            throw authFailure();
        }
    }
    if (state.spec.blockSize === BLOCK) {
        if (state.autoPadding) {
            if (state.direction === 'encrypt') {
                const pad = BLOCK - (rest.length % BLOCK);
                const block = new Uint8Array(rest.length + pad);
                block.set(rest, 0);
                block.fill(pad, rest.length);
                return { data: transformBlocks(state, block) };
            }
            if (rest.length === 0 || rest.length % BLOCK !== 0) throw wrongFinalBlock();
            return { data: unpad(transformBlocks(state, rest)) };
        }
        if (rest.length % BLOCK !== 0) throw wrongFinalBlock();
        return { data: rest.length === 0 ? rest : transformBlocks(state, rest) };
    }
    return { data: new Uint8Array(0) };
}

function stateFor(id: unknown, op: string): CipherState {
    const state = CIPHER_STATE.get(Number(id));
    if (state === undefined) throw invalidState(op);
    return state;
}

function openCipher(args: any): { id: number; aead: boolean } {
    const spec = CIPHER_SPECS[String(args?.algorithm ?? '').toLowerCase()];
    if (spec === undefined) throw cipherFail('ERR_CRYPTO_UNKNOWN_CIPHER', 'Unknown cipher');
    /* Node reports a bad IV before a bad key, and an unknown cipher before either. */
    const iv = typeof args?.iv === 'string' ? base64ToBytes(args.iv) : new Uint8Array(0);
    if (spec.ivLength === 0) {
        if (iv.length !== 0) throw invalidIv();
    } else if (spec.ivLength > 0) {
        if (iv.length !== spec.ivLength) throw invalidIv();
    } else if (iv.length < GCM_MIN_IV) {
        throw invalidIv();
    }
    const key = bytesArg(args?.key);
    if (key.length !== spec.keyLength) throw invalidKeyLength();
    if (CIPHER_STATE.size >= OPEN_CIPHER_LIMIT) {
        const oldest = CIPHER_STATE.keys().next().value;
        if (oldest !== undefined) CIPHER_STATE.delete(oldest);
    }
    const id = nextCipherId++;
    CIPHER_STATE.set(id, {
        spec,
        direction: args?.direction === 'decrypt' ? 'decrypt' : 'encrypt',
        key,
        iv,
        counterOffset: 0,
        chainBuf: new Uint8Array(BLOCK),
        keystream: null,
        pending: new Uint8Array(0),
        autoPadding: true,
        updated: false,
        aad: new Uint8Array(0)
    });
    return { id, aead: spec.aead };
}

export const CRYPTO_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** Args {algorithm, data}: the digest of the bytes; returns base64. */
    'crypto.digest': (args) => bytesToBase64(digestFor(args?.algorithm)(bytesArg(args?.data))),
    /** Args {algorithm, key, data}: the HMAC of the bytes; returns base64. */
    'crypto.hmac': (args) => bytesToBase64(hmac(digestFor(args?.algorithm), bytesArg(args?.key), bytesArg(args?.data))),
    /** Args {digest, password, salt, iterations, keylen}: the derived key; returns base64. */
    'crypto.pbkdf2': (args) => bytesToBase64(pbkdf2(digestFor(args?.digest), bytesArg(args?.password), bytesArg(args?.salt), {
        c: Number(args?.iterations),
        dkLen: Number(args?.keylen)
    })),
    /** Args {}: the cipher names createCipheriv and createDecipheriv accept. */
    'crypto.ciphers': () => Object.keys(CIPHER_SPECS),
    /** Args {algorithm, direction, key, iv}: validates key and IV, opens a host cipher; returns {id, aead}. */
    'crypto.cipher.open': (args) => openCipher(args),
    /** Args {id, data}: the bytes this call emits; aead modes emit nothing until final. Returns base64. */
    'crypto.cipher.update': (args) => bytesToBase64(cipherUpdate(stateFor(args?.id, 'update'), bytesArg(args?.data))),
    /** Args {id}: the last bytes, with padding added or removed. Returns {data, tag?}. Releases the state. */
    'crypto.cipher.final': (args) => {
        const state = stateFor(args?.id, 'final');
        const result = cipherFinal(state);
        CIPHER_STATE.delete(Number(args?.id));
        return { data: bytesToBase64(result.data), tag: result.tag === undefined ? undefined : bytesToBase64(result.tag) };
    },
    /** Args {id, aad}: the additional authenticated data of an AEAD cipher; only before any data. */
    'crypto.cipher.setAAD': (args) => {
        const state = stateFor(args?.id, 'setAAD');
        if (!state.spec.aead || state.updated) invalidState('setAAD');
        state.aad = bytesArg(args?.aad);
        return true;
    },
    /** Args {id, tag}: the authentication tag a decrypting AEAD cipher checks its input against. */
    'crypto.cipher.setAuthTag': (args) => {
        const state = stateFor(args?.id, 'setAuthTag');
        if (!state.spec.aead) invalidState('setAuthTag');
        state.tag = bytesArg(args?.tag);
        return true;
    },
    /** Args {id, on}: whether ECB and CBC add and remove PKCS#7 padding. */
    'crypto.cipher.setAutoPadding': (args) => {
        stateFor(args?.id, 'setAutoPadding').autoPadding = args?.on !== false;
        return true;
    },
};
