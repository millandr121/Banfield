import { ClientMessage, ServerMessage } from "../../shared/protocol";

// Thin WebSocket wrapper. Auto-reconnect kept minimal for the prototype.
export class Net {
  private ws: WebSocket | null = null;
  private onMsg: (m: ServerMessage) => void;
  private queue: ClientMessage[] = [];

  constructor(onMsg: (m: ServerMessage) => void) {
    this.onMsg = onMsg;
  }

  connect() {
    // Idempotent: the login screen opens the socket early, then start() may call
    // again — don't stack a second connection on top of a live one.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.addEventListener("open", () => {
      for (const m of this.queue) this.rawSend(m);
      this.queue = [];
    });
    this.ws.addEventListener("message", (ev) => {
      this.onMsg(JSON.parse(ev.data) as ServerMessage);
    });
    this.ws.addEventListener("close", () => {
      this.ws = null;
      setTimeout(() => this.connect(), 1000);
    });
  }

  send(m: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.rawSend(m);
    else this.queue.push(m);
  }

  private rawSend(m: ClientMessage) {
    this.ws?.send(JSON.stringify(m));
  }
}
