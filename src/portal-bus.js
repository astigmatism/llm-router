// Server-Sent Events fan-out for the portal.
//
// The API port already streams capability changes to clients; the dashboard
// needs a different feed - one request persisted, one lifecycle event, a drain
// flip - and needs it same-origin on the admin port. A slow browser must never
// slow the router down, so a subscriber that cannot keep up is dropped with a
// final `retry` frame rather than buffering unboundedly.

const MAX_SUBSCRIBERS = 8;
const HIGH_WATER = 256 * 1024;

export class PortalBus {
  constructor({ heartbeatMs = 15000, heartbeat = null } = {}) {
    this.subscribers = new Set();
    this.sequence = 0;
    this.heartbeatMs = heartbeatMs;
    this.heartbeat = heartbeat;
    this.timer = null;
    if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
      this.timer = setInterval(() => this.beat(), heartbeatMs);
      this.timer.unref?.();
    }
  }

  get size() {
    return this.subscribers.size;
  }

  beat() {
    if (!this.subscribers.size) return;
    const payload = typeof this.heartbeat === 'function' ? this.heartbeat() : { at: new Date().toISOString() };
    this.publish('heartbeat', payload);
  }

  subscribe(request, response, hello) {
    if (this.subscribers.size >= MAX_SUBSCRIBERS) return false;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    response.write('retry: 2000\n\n');
    const subscriber = { response, dropped: false };
    this.subscribers.add(subscriber);
    if (hello) this.send(subscriber, 'hello', typeof hello === 'function' ? hello() : hello);
    const cleanup = () => this.subscribers.delete(subscriber);
    request.on('close', cleanup);
    request.on('error', cleanup);
    response.on('close', cleanup);
    return true;
  }

  send(subscriber, type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
    try {
      subscriber.response.write(frame);
    } catch {
      this.subscribers.delete(subscriber);
    }
  }

  /**
   * Publish to every subscriber.
   *
   * Returns how many subscribers received the frame. Backpressure is treated
   * as a dead browser: the request asked for live data, and a tab that has
   * stopped reading is better replaced by its next poll than allowed to hold
   * the router's memory.
   */
  publish(type, data) {
    if (!this.subscribers.size) return 0;
    this.sequence += 1;
    const frame = `id: ${this.sequence}\nevent: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.response.writableLength > HIGH_WATER) {
        this.subscribers.delete(subscriber);
        subscriber.dropped = true;
        try { subscriber.response.end(`retry: 5000\n\n`); } catch { /* already gone */ }
        continue;
      }
      this.send(subscriber, type, data);
    }
    return this.subscribers.size;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const subscriber of this.subscribers) {
      try { subscriber.response.end(); } catch { /* already gone */ }
    }
    this.subscribers.clear();
  }
}
