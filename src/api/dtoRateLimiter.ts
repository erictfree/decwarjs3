// src/http/dtoRateLimiter.ts
import type { Request, Response, NextFunction } from "express";

type KeyFn = (req: Request) => string;
type Options = {
    max?: number;                  // max requests allowed in window (default: 5)
    windowMs?: number;             // rolling window size in ms (default: 5000)
    key?: KeyFn;                   // bucket key function (default: req.ip)
    headerRetryAfter?: boolean;    // send Retry-After header (default: true)
    verbose?: boolean;             // console log decisions (default: true)
    cleanupAfterMs?: number;       // evict idle buckets after this idle time (default: 10 * windowMs)
};

type Bucket = number[]; // ascending timestamps (ms) of recent requests within window

export function dtoRateLimiter(opts: Options = {}) {
    const max = Math.max(1, Math.floor(opts.max ?? 5));
    const windowMs = Math.max(1, Math.floor(opts.windowMs ?? 5000));
    const keyFn: KeyFn = opts.key ?? ((req) => req.ip || "unknown");
    const verbose = opts.verbose !== false;
    const sendRetryAfter = opts.headerRetryAfter !== false;
    const cleanupAfterMs = Math.max(windowMs, Math.floor(opts.cleanupAfterMs ?? 10 * windowMs));

    const buckets = new Map<string, { q: Bucket; lastSeen: number }>();

    return function limiter(req: Request, res: Response, next: NextFunction) {
        const now = Date.now();
        const key = keyFn(req);

        const bucket = buckets.get(key) ?? { q: [], lastSeen: now };
        const q = bucket.q;

        // purge timestamps outside the rolling window
        const cutoff = now - windowMs;
        while (q.length && q[0] <= cutoff) q.shift();

        bucket.lastSeen = now;

        if (q.length < max) {
            // allow: record this request timestamp
            q.push(now);
            buckets.set(key, bucket);
            if (verbose) {
                console.log(`[DTO-RL] allow key=${key} path=${req.path} used=${q.length}/${max}`);
            }
            return next();
        }

        // deny: compute precise wait until the earliest timestamp leaves the window
        const retryInMs = Math.max(1, q[0] + windowMs - now);
        if (sendRetryAfter) {
            res.setHeader("Retry-After", String(Math.ceil(retryInMs / 1000)));
        }

        if (verbose) {
            console.warn(
                `[DTO-RL] 429 key=${key} path=${req.path} used=${q.length}/${max} waitMs=${retryInMs}`
            );
        }

        return res.status(429).json({
            error: "rate_limited",
            message: `DTO limited to ${max} requests per ${windowMs / 1000}s (sliding window).`,
            retryInMs,
        });
    };
}

// Optional: lightweight periodic cleanup (call once at startup)
export function startDtoRlCleanup(map: Map<string, { q: number[]; lastSeen: number }>, idleMs: number) {
    const interval = Math.max(10_000, Math.floor(idleMs / 2));
    return setInterval(() => {
        const now = Date.now();
        for (const [k, v] of map) {
            if (now - v.lastSeen > idleMs) map.delete(k);
        }
    }, interval);
}
