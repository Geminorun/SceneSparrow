/** One bounded intent per action; callbacks read committed input at delivery time. */
export class CompositionActions {
  private sources = new Set<string>();
  private generations = new Map<string, number>();
  private blurTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, { run: () => void; cancel: () => void }>();
  private running = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  contextVersion = 0;
  get composing() {
    return this.sources.size > 0;
  }
  composition(source: string, active: boolean) {
    if (this.disposed) return;
    this.generations.set(source, (this.generations.get(source) ?? 0) + 1);
    clearTimeout(this.blurTimers.get(source));
    this.blurTimers.delete(source);
    if (active) this.sources.add(source);
    else this.sources.delete(source);
    clearTimeout(this.timer);
    // compositionend may precede the final input/React commit in the same turn.
    if (!this.composing)
      this.timer = setTimeout(() => {
        for (const intent of this.pending.values()) intent.run();
      }, 0);
  }
  blur(source: string, commit: () => void) {
    if (this.disposed || !this.sources.has(source)) return;
    const generation = this.generations.get(source);
    clearTimeout(this.blurTimers.get(source));
    this.blurTimers.set(
      source,
      setTimeout(() => {
        this.blurTimers.delete(source);
        if (
          !this.disposed &&
          this.sources.has(source) &&
          generation === this.generations.get(source)
        )
          commit();
      }, 0),
    );
  }
  run<T>(
    key: string,
    action: () => T | Promise<T>,
    valid = () => true,
  ): Promise<T | false> {
    if (this.disposed) return Promise.resolve(false);
    const existing = this.running.get(key);
    if (existing) return existing as Promise<T | false>;
    if (this.pending.size >= 8) return Promise.resolve(false);
    let cancelled = false;
    const promise = new Promise<T | false>((resolve, reject) => {
      const intent = {
        run: () => {
          void Promise.resolve().then(() => {
            // Other delivered actions can navigate/unmount before this microtask.
            if (cancelled || this.disposed || !valid()) {
              if (this.pending.get(key) === intent) this.pending.delete(key);
              resolve(false);
              return;
            }
            if (this.composing) return;
            this.pending.delete(key);
            try {
              Promise.resolve(action()).then(resolve, reject);
            } catch (error) {
              reject(error);
            }
          });
        },
        cancel: () => {
          cancelled = true;
          resolve(false);
        },
      };
      this.pending.set(key, intent);
      if (!this.composing) intent.run();
    }).finally(() => {
      if (this.running.get(key) === promise) this.running.delete(key);
    });
    this.running.set(key, promise);
    return promise;
  }
  cancel(key?: string) {
    if (key === undefined) this.contextVersion++;
    for (const [identity, intent] of this.pending)
      if (key === undefined || identity === key) {
        this.pending.delete(identity);
        this.running.delete(identity);
        intent.cancel();
      }
  }
  cancelScope(prefix: string) {
    for (const key of this.pending.keys())
      if (key.startsWith(prefix)) this.cancel(key);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.cancel();
    this.sources.clear();
    this.generations.clear();
    for (const timer of this.blurTimers.values()) clearTimeout(timer);
    this.blurTimers.clear();
  }
}
