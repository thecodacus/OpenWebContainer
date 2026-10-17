/* A minimal event emitter (on, once, off, emit) that runs the same in Node and in the OWC guest. */

type Listener = (...args: any[]) => void;

export class Emitter {
    private readonly listenersByName = new Map<string, Listener[]>();

    on(name: string, listener: Listener): this {
        const list = this.listenersByName.get(name);
        if (list) list.push(listener);
        else this.listenersByName.set(name, [listener]);
        return this;
    }

    once(name: string, listener: Listener): this {
        const wrapper: Listener = (...args) => {
            this.off(name, wrapper);
            listener(...args);
        };
        (wrapper as Listener & { original?: Listener }).original = listener;
        return this.on(name, wrapper);
    }

    off(name: string, listener: Listener): this {
        const list = this.listenersByName.get(name);
        if (!list) return this;
        const index = list.findIndex((entry) => entry === listener || (entry as Listener & { original?: Listener }).original === listener);
        if (index >= 0) list.splice(index, 1);
        return this;
    }

    listenerCount(name: string): number {
        return this.listenersByName.get(name)?.length ?? 0;
    }

    emit(name: string, ...args: unknown[]): boolean {
        const list = this.listenersByName.get(name);
        if (!list || list.length === 0) return false;
        for (const listener of list.slice()) listener(...args);
        return true;
    }
}
