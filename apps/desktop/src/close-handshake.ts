// Keeps late renderer replies from closing a newer close attempt.
export class CloseHandshake {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private accept: () => void,
    private unresponsive: () => Promise<boolean>,
    private timeoutMs = 15000,
    private cancelled: (nonce: string) => void = () => {},
  ) {}
  get isPending() {
    return this.pending !== null;
  }
  request(nonce: string, send: (nonce: string) => void) {
    if (this.pending) return;
    this.pending = nonce;
    this.timer = setTimeout(() => {
      void this.timeout(nonce);
    }, this.timeoutMs);
    send(nonce);
  }
  private async timeout(nonce: string) {
    if (this.pending !== nonce) return;
    const allowed = await this.unresponsive();
    if (this.pending === nonce) {
      this.pending = null;
      if (allowed) this.accept();
      else this.cancelled(nonce);
    }
  }
  responsive(nonce: unknown) {
    if (nonce === this.pending) clearTimeout(this.timer);
  }
  rendererLost() {
    if (this.pending) void this.timeout(this.pending);
  }
  reply(nonce: unknown, allowed: unknown) {
    if (nonce !== this.pending || !this.pending) return;
    const completed = this.pending;
    clearTimeout(this.timer);
    this.pending = null;
    if (allowed === true) this.accept();
    else this.cancelled(completed);
  }
  dispose() {
    clearTimeout(this.timer);
    this.pending = null;
  }
}
