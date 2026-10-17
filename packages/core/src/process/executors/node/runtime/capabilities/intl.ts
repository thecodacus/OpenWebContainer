import { CapabilityHandler } from './types';

/*
 * Host side of the guest Intl object (guest/modules/intl.ts). Every operation runs on the host's own Intl,
 * so locale data, option resolution and the default time zone are the host's, as in the Node reference.
 * The guest sends {kind, locales, options, value, method?} as JSON, so values JSON cannot carry are tagged:
 * numbers as 'NaN', 'Infinity', '-Infinity' or '-0'; BigInt as {bigint: "digits"}; string numerics as
 * {str: "..."}. Dates are epoch milliseconds. A host TypeError or RangeError comes back as ERR_INTL_TYPE or
 * ERR_INTL_RANGE, and the guest throws the same error class with the host's message.
 */

const CONSTRUCTORS = new Set(['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat']);
const DATE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
const CACHE_LIMIT = 256;
const instances = new Map<string, any>();

interface IntlCall {
    kind?: unknown;
    locales?: unknown;
    options?: unknown;
    value?: unknown;
    method?: unknown;
}

function constructorName(name: unknown): string {
    if (typeof name !== 'string' || !CONSTRUCTORS.has(name)) {
        throw new RangeError(`Unknown Intl constructor ${String(name)}`);
    }
    return name;
}

/** One host object per constructor, locales and options. Construction validates them, so bad options fail at once. */
function instanceOf(name: unknown, locales: unknown, options: unknown): any {
    const ctor = constructorName(name);
    const key = `${ctor}\u0000${JSON.stringify({ l: locales, o: options })}`;
    let made = instances.get(key);
    if (made === undefined) {
        const Ctor = (Intl as any)[ctor];
        made = new Ctor(locales, options);
        if (instances.size >= CACHE_LIMIT) instances.delete(instances.keys().next().value as string);
        instances.set(key, made);
    }
    return made;
}

/** Decodes a number the guest encoded for JSON. */
function numberOf(value: unknown): number {
    if (typeof value === 'number') return value;
    if (value === 'NaN') return NaN;
    if (value === 'Infinity') return Infinity;
    if (value === '-Infinity') return -Infinity;
    if (value === '-0') return -0;
    throw new TypeError('Intl: expected a number');
}

/** A NumberFormat operand: a number, a BigInt or an exact decimal string. */
function operandOf(value: unknown): number | bigint | string {
    if (value !== null && typeof value === 'object') {
        const tagged = value as { bigint?: unknown; str?: unknown };
        if (typeof tagged.bigint === 'string') return BigInt(tagged.bigint);
        if (typeof tagged.str === 'string') return tagged.str;
        throw new TypeError('Intl: unsupported numeric operand');
    }
    return numberOf(value);
}

function run(call: IntlCall): unknown {
    const { locales, options, value } = call;
    switch (call.kind) {
        case 'dateFormat':
            return instanceOf('DateTimeFormat', locales, options).format(new Date(numberOf(value)));
        case 'dateFormatToParts':
            return instanceOf('DateTimeFormat', locales, options).formatToParts(new Date(numberOf(value)));
        case 'dateToLocale': {
            const method = call.method;
            if (typeof method !== 'string' || !DATE_METHODS.has(method)) throw new RangeError('Unknown Date locale method');
            return (new Date(numberOf(value)) as any)[method](locales, options);
        }
        case 'numberFormat':
            return instanceOf('NumberFormat', locales, options).format(operandOf(value));
        case 'numberFormatToParts':
            return instanceOf('NumberFormat', locales, options).formatToParts(operandOf(value));
        case 'collate': {
            const [a, b] = value as [string, string];
            return instanceOf('Collator', locales, options).compare(a, b);
        }
        case 'pluralSelect':
            return instanceOf('PluralRules', locales, options).select(numberOf(value));
        case 'relativeFormat': {
            const [amount, unit] = value as [unknown, string];
            return instanceOf('RelativeTimeFormat', locales, options).format(numberOf(amount), unit);
        }
        case 'listFormat':
            return instanceOf('ListFormat', locales, options).format(value as string[]);
        case 'resolvedOptions':
            return instanceOf(value, locales, options).resolvedOptions();
        case 'supportedLocalesOf':
            return (Intl as any)[constructorName(value)].supportedLocalesOf(locales, options);
        case 'canonicalLocales':
            return (Intl as any).getCanonicalLocales(locales);
        case 'supportedValuesOf':
            return (Intl as any).supportedValuesOf(value);
        default:
            throw new RangeError(`Unknown Intl operation ${String(call.kind)}`);
    }
}

export const INTL_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** Args {kind, locales, options, value, method?}: the result of one Intl operation, run on the host. */
    'intl.call': (args) => {
        try {
            return run(args as IntlCall);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof TypeError ? 'ERR_INTL_TYPE' : 'ERR_INTL_RANGE';
            throw Object.assign(new Error(message), { code });
        }
    }
};
