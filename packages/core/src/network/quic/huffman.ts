/*
 * The HPACK Huffman code (RFC 7541 Section 5.2 and Appendix B), which QPACK string literals use
 * unchanged (RFC 9204 Section 4.1.2). HUFFMAN_CODES[s] holds the code of symbol s, right-aligned in
 * HUFFMAN_LENGTHS[s] bits; symbol 256 is EOS. The two tables were derived from the saved RFC 7541
 * text and are equal to the tables of the guest http2 module (HUFF_CODE, HUFF_LEN); that module is a
 * plain-JavaScript snippet that this bundle cannot import, hence the copy.
 */

export const HUFFMAN_CODES: readonly number[] = [8184,8388568,268435426,268435427,268435428,268435429,268435430,268435431,268435432,16777194,1073741820,268435433,268435434,1073741821,268435435,268435436,268435437,268435438,268435439,268435440,268435441,268435442,1073741822,268435443,268435444,268435445,268435446,268435447,268435448,268435449,268435450,268435451,20,1016,1017,4090,8185,21,248,2042,1018,1019,249,2043,250,22,23,24,0,1,2,25,26,27,28,29,30,31,92,251,32764,32,4091,1020,8186,33,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,252,115,253,8187,524272,8188,16380,34,32765,3,35,4,36,5,37,38,39,6,116,117,40,41,42,7,43,118,44,8,9,45,119,120,121,122,123,32766,2044,16381,8189,268435452,1048550,4194258,1048551,1048552,4194259,4194260,4194261,8388569,4194262,8388570,8388571,8388572,8388573,8388574,16777195,8388575,16777196,16777197,4194263,8388576,16777198,8388577,8388578,8388579,8388580,2097116,4194264,8388581,4194265,8388582,8388583,16777199,4194266,2097117,1048553,4194267,4194268,8388584,8388585,2097118,8388586,4194269,4194270,16777200,2097119,4194271,8388587,8388588,2097120,2097121,4194272,2097122,8388589,4194273,8388590,8388591,1048554,4194274,4194275,4194276,8388592,4194277,4194278,8388593,67108832,67108833,1048555,524273,4194279,8388594,4194280,33554412,67108834,67108835,67108836,134217694,134217695,67108837,16777201,33554413,524274,2097123,67108838,134217696,134217697,67108839,134217698,16777202,2097124,2097125,67108840,67108841,268435453,134217699,134217700,134217701,1048556,16777203,1048557,2097126,4194281,2097127,2097128,8388595,4194282,4194283,33554414,33554415,16777204,16777205,67108842,8388596,67108843,134217702,67108844,67108845,134217703,134217704,134217705,134217706,134217707,268435454,134217708,134217709,134217710,134217711,134217712,67108846,1073741823];

export const HUFFMAN_LENGTHS: readonly number[] = [13,23,28,28,28,28,28,28,28,24,30,28,28,30,28,28,28,28,28,28,28,28,30,28,28,28,28,28,28,28,28,28,6,10,10,12,13,6,8,11,10,10,8,11,8,6,6,6,5,5,5,6,6,6,6,6,6,6,7,8,15,6,12,10,13,6,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,8,7,8,13,19,13,14,6,15,5,6,5,6,5,6,6,6,5,7,7,6,6,6,5,6,7,6,5,5,6,7,7,7,7,7,15,11,14,13,28,20,22,20,20,22,22,22,23,22,23,23,23,23,23,24,23,24,24,22,23,24,23,23,23,23,21,22,23,22,23,23,24,22,21,20,22,22,23,23,21,23,22,22,24,21,22,23,23,21,21,22,21,23,22,23,23,20,22,22,22,23,22,22,23,26,26,20,19,22,23,22,25,26,26,26,27,27,26,24,25,19,21,26,27,27,26,27,24,21,21,26,26,28,27,27,27,20,24,20,21,22,21,21,23,22,22,25,25,24,24,26,23,26,27,26,26,27,27,27,27,27,28,27,27,27,27,27,26,30];

const EOS = 256;

/** A Huffman-coded string that does not decode (RFC 7541 Section 5.2). */
export class HuffmanError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HuffmanError';
    }
}

/** Length in bytes of the Huffman coding of bytes, padding included. */
export function huffmanEncodedLength(bytes: Uint8Array): number {
    let bits = 0;
    for (let i = 0; i < bytes.length; i++) bits += HUFFMAN_LENGTHS[bytes[i]];
    return Math.ceil(bits / 8);
}

/** Huffman-codes bytes, padding the last byte with the most significant bits of EOS (all ones). */
export function huffmanEncode(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(huffmanEncodedLength(bytes));
    let n = 0;
    // At most 7 pending bits plus one code of at most 30 bits: below 2^37, exact in a double.
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < bytes.length; i++) {
        const sym = bytes[i];
        const len = HUFFMAN_LENGTHS[sym];
        acc = acc * 2 ** len + HUFFMAN_CODES[sym];
        bits += len;
        while (bits >= 8) {
            bits -= 8;
            const div = 2 ** bits;
            out[n++] = Math.floor(acc / div);
            acc %= div;
        }
    }
    if (bits > 0) {
        const pad = 8 - bits;
        out[n++] = acc * 2 ** pad + (2 ** pad - 1);
    }
    return out;
}

interface DecodeTree {
    readonly zero: Int16Array;
    readonly one: Int16Array;
    readonly symbol: Int16Array;
}

let tree: DecodeTree | null = null;

function decodeTree(): DecodeTree {
    if (tree !== null) return tree;
    // 257 leaves in a full binary tree: 513 nodes.
    const zero = new Int16Array(513).fill(-1);
    const one = new Int16Array(513).fill(-1);
    const symbol = new Int16Array(513).fill(-1);
    let nodes = 1;
    for (let s = 0; s <= EOS; s++) {
        let node = 0;
        for (let b = HUFFMAN_LENGTHS[s] - 1; b >= 0; b--) {
            const bit = Math.floor(HUFFMAN_CODES[s] / 2 ** b) % 2;
            const next = bit === 1 ? one : zero;
            if (next[node] < 0) next[node] = nodes++;
            node = next[node];
        }
        symbol[node] = s;
    }
    tree = { zero, one, symbol };
    return tree;
}

/**
 * Decodes a Huffman-coded string. Throws HuffmanError for a code that is not in the table, an EOS
 * symbol inside the string, padding longer than 7 bits, or padding that is not a prefix of EOS
 * (RFC 7541 Section 5.2).
 */
export function huffmanDecode(bytes: Uint8Array): Uint8Array {
    const { zero, one, symbol } = decodeTree();
    // The shortest code is 5 bits, so the output holds at most 8/5 symbols per input byte.
    const out = new Uint8Array(Math.floor((bytes.length * 8) / 5));
    let n = 0;
    let node = 0;
    let pending = 0;
    let allOnes = true;
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        for (let k = 7; k >= 0; k--) {
            const bit = (byte >> k) & 1;
            node = bit === 1 ? one[node] : zero[node];
            if (node < 0) throw new HuffmanError('invalid Huffman code');
            pending++;
            if (bit === 0) allOnes = false;
            const s = symbol[node];
            if (s >= 0) {
                if (s === EOS) throw new HuffmanError('EOS symbol inside a Huffman-coded string');
                out[n++] = s;
                node = 0;
                pending = 0;
                allOnes = true;
            }
        }
    }
    if (pending > 7) throw new HuffmanError('Huffman padding longer than 7 bits');
    if (pending > 0 && !allOnes) throw new HuffmanError('Huffman padding is not a prefix of EOS');
    return out.slice(0, n);
}
