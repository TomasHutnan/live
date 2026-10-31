import { CLOSE, PROTOCOL_VERSION, type ServerMessage } from "../shared/protocol.ts";
import { DEAD_AFTER_MS, PING_MS, RECONNECT_MAX_MS, RECONNECT_MIN_MS } from "./tuning.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "over";

export interface ConnectionOptions {
  slug: string;
  /** Presenter only: returns a fresh token, used once for one connect. */
  fetchToken?: () => Promise<string>;
  onMessage: (message: ServerMessage) => void;
  onState: (state: ConnectionState) => void;
}

export class Connection {
  private socket?: WebSocket;
  private attempts = 0;
  private lastSeen = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private beat?: ReturnType<typeof setInterval>;
  private over = false;

  constructor(private readonly options: ConnectionOptions) {
    window.addEventListener("online", () => this.retryNow());
  }

  start(): void {
    this.options.onState("connecting");
    void this.open();
  }

  /** Sends now if connected. Returns false otherwise, so callers can keep the message. */
  send(message: object): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
    return true;
  }

  private retryNow(): void {
    if (this.over || !this.retry) return;
    clearTimeout(this.retry);
    this.retry = undefined;
    void this.open();
  }

  private scheduleRetry(): void {
    if (this.over || this.retry) return;
    this.options.onState("reconnecting");
    const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempts);
    this.attempts += 1;
    const delay = ceiling / 2 + (Math.random() * ceiling) / 2;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.open();
    }, delay);
  }

  private async open(): Promise<void> {
    let token: string | undefined;
    if (this.options.fetchToken) {
      try {
        token = await this.options.fetchToken();
      } catch {
        this.scheduleRetry();
        return;
      }
    }
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws/${this.options.slug}`);
    this.socket = socket;

    socket.onopen = () => {
      this.lastSeen = Date.now();
      if (token) this.send({ t: "auth", token });
      this.beat = setInterval(() => this.heartbeat(socket), PING_MS);
    };
    socket.onmessage = (event) => {
      this.lastSeen = Date.now();
      const message = JSON.parse(event.data as string) as ServerMessage;
      if (message.t === "pong") return;
      if (message.t === "session.removed") this.end();
      if (message.t === "snapshot" && (!token || message.role === "presenter")) {
        this.attempts = 0;
        this.options.onState("connected");
      }
      this.options.onMessage(message);
    };
    socket.onclose = (event) => {
      clearInterval(this.beat);
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (event.code === CLOSE.noSession || event.code === CLOSE.removed) this.end();
      else this.scheduleRetry();
    };
  }

  private heartbeat(socket: WebSocket): void {
    if (Date.now() - this.lastSeen > DEAD_AFTER_MS) {
      socket.close();
      return;
    }
    this.send({ t: "ping" });
  }

  private end(): void {
    if (this.over) return;
    this.over = true;
    this.options.onState("over");
    this.options.onMessage({ v: PROTOCOL_VERSION, t: "session.removed" });
  }
}
