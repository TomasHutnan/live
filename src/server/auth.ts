import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verify } from "@node-rs/argon2";
import type { FastifyReply, FastifyRequest } from "fastify";

const CACHE_MS = 60_000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 5 * 60_000;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * HTTP Basic auth. Browsers resend the header on every request, so a good
 * header is remembered briefly, under an HMAC with a per-process key, so
 * neither the password nor a reversible form of it stays in memory.
 */
export class BasicAuth {
  private readonly key = randomBytes(32);
  private readonly verified = new Map<string, number>();
  /** Headers that passed in this process. The password can't change without a restart. */
  private readonly known = new Set<string>();
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly user: string,
    private readonly passwordHash: string,
    private readonly now: () => number = Date.now,
  ) {}

  private fingerprint(header: string): string {
    return createHmac("sha256", this.key).update(header).digest("base64");
  }

  /**
   * Milliseconds left on the lockout for this IP, or 0. A header that has
   * already passed is exempt: a whole university can share one address, and
   * someone guessing there must not lock the presenter out mid-class.
   */
  blockedFor(ip: string, header?: string): number {
    if (header && this.known.has(this.fingerprint(header))) return 0;
    const entry = this.failures.get(ip);
    if (!entry) return 0;
    const left = entry.since + FAILURE_WINDOW_MS - this.now();
    if (left <= 0) {
      this.failures.delete(ip);
      return 0;
    }
    return entry.count >= MAX_FAILURES ? left : 0;
  }

  private recordFailure(ip: string): void {
    const entry = this.failures.get(ip);
    if (entry && this.now() - entry.since < FAILURE_WINDOW_MS) entry.count += 1;
    else this.failures.set(ip, { count: 1, since: this.now() });
  }

  async check(header: string | undefined, ip: string): Promise<boolean> {
    const fingerprint = header ? this.fingerprint(header) : "";
    const expires = this.verified.get(fingerprint);
    if (expires !== undefined) {
      if (expires > this.now()) return true;
      this.verified.delete(fingerprint);
    }
    if (!header) return false;

    const ok = await this.verifyHeader(header);
    if (ok) {
      this.verified.set(fingerprint, this.now() + CACHE_MS);
      this.known.add(fingerprint);
      this.failures.delete(ip);
    } else {
      this.recordFailure(ip);
    }
    return ok;
  }

  private async verifyHeader(header: string): Promise<boolean> {
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
    if (!match?.[1]) return false;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return false;
    const password = decoded.slice(colon + 1);
    // Always run Argon2, so a wrong username takes as long as a wrong password.
    const passwordOk = await verify(this.passwordHash, password).catch(() => false);
    return same(decoded.slice(0, colon), this.user) && passwordOk;
  }

  /** Fastify preHandler for every password-protected route. */
  guard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const blocked = this.blockedFor(request.ip, request.headers.authorization);
    if (blocked > 0) {
      await reply
        .code(429)
        .header("Retry-After", Math.ceil(blocked / 1000))
        .type("text/plain; charset=utf-8")
        .send("Too many failed attempts. Try again later.\n");
      return;
    }
    if (await this.check(request.headers.authorization, request.ip)) return;
    await reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="live", charset="UTF-8"')
      .type("text/plain; charset=utf-8")
      .send("Authentication required.\n");
  };
}
