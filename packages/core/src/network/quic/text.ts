/* UTF-8 for CONNECTION_CLOSE reason phrases and stream writes of strings; QuickJS has no TextEncoder. */

export function utf8Encode(text: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                i++;
            } else {
                c = 0xfffd;
            }
        } else if (c >= 0xd800 && c <= 0xdfff) {
            c = 0xfffd;
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
}

/** Lenient decode: malformed sequences become U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i];
        let cp = 0xfffd;
        let need = 0;
        if (b < 0x80) {
            cp = b;
        } else if (b >= 0xc2 && b <= 0xdf) {
            need = 1;
            cp = b & 0x1f;
        } else if (b >= 0xe0 && b <= 0xef) {
            need = 2;
            cp = b & 0x0f;
        } else if (b >= 0xf0 && b <= 0xf4) {
            need = 3;
            cp = b & 0x07;
        }
        i++;
        let ok = true;
        for (let k = 0; k < need; k++) {
            const next = bytes[i];
            if (next === undefined || (next & 0xc0) !== 0x80) {
                ok = false;
                break;
            }
            cp = (cp << 6) | (next & 0x3f);
            i++;
        }
        if (!ok || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
        if (cp >= 0x10000) {
            cp -= 0x10000;
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
            out += String.fromCharCode(cp);
        }
    }
    return out;
}
