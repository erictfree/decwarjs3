// src/http/dtoRateLimiter.ts
import type { Request, Response, NextFunction } from "express";

type KeyFn = (req: Request) => string;
type Options = {
    ratePerSec?: number;            // steady rate (tokens added per second)
    burst?: number;                 // max tokens (allows small bursts)
    key?: KeyFn;                    // how to bucket clients (default: req.ip)
    headerRetryAfter?: boolean;     // send Retry-After header (default: true)
    verbose?: boolean;              // console log decisions (default: true)
};

type Bucket = { tokens: number; lastTs: number };

export function dtoRateLimiter(opts: Options = {}) {
    const rate = Math.max(0.001, opts.ratePerSec ?? 1); // default 1/sec
    const burst = Math.max(1, Math.floor(opts.burst ?? 1));
    const keyFn: KeyFn = opts.key ?? ((req) => req.ip || "unknown");
    const verbose = opts.verbose !== false; // default true
    const buckets = new Map<string, Bucket>();

    return function limiter(req: Request, res: Response, next: NextFunction) {
        const now = Date.now();
        const key = keyFn(req);
        const b = buckets.get(key) ?? { tokens: burst, lastTs: now };
        // refill tokens based on elapsed time
        const elapsedSec = (now - b.lastTs) / 1000;
        b.tokens = Math.min(burst, b.tokens + elapsedSec * rate);
        b.lastTs = now;

        if (b.tokens >= 1) {
            b.tokens -= 1;
            buckets.set(key, b);
            if (verbose) {
                console.log(
                    `[DTO-RL] allow key=${key} path=${req.path} tokens=${b.tokens.toFixed(2)}`
                );
            }
            return next();
        }

        // compute wait time until next token
        const needed = 1 - b.tokens;
        const waitSec = needed / rate; // seconds
        const retryMs = Math.ceil(waitSec * 1000);

        if (opts.headerRetryAfter !== false) {
            res.setHeader("Retry-After", Math.max(1, Math.ceil(waitSec)).toString());
        }

        if (verbose) {
            console.warn(
                `[DTO-RL] 429 key=${key} path=${req.path} tokens=${b.tokens.toFixed(2)} waitMs=${retryMs}`
            );
        }

        res.status(429).json({
            error: "rate_limited",
            message: "DTO endpoint limited to 1 request per second.",
            retryInMs: retryMs,
        });
    };
}
