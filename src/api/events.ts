// src/api/events.ts
import type { Player } from "../player.js";
import type { Planet } from "../planet.js";
import type { Side } from "../settings.js";

/* =========================
 * Public event catalog/types
 * ========================= */

export type EventType =
    | "ship_moved"
    | "phaser"
    | "torpedo"
    | "planet_hit"
    | "planet_builds_changed"
    | "planet_energy_changed"
    | "planet_captured"
    | "base_built"              // kept for back-compat with emitBaseBuilt()
    | "planet_base_created"
    | "planet_base_removed"
    | "base_destroyed"
    | "score_changed";

export type GridCoord = { v: number; h: number };

export type PlanetRef = {
    name: string;
    side: Side;
    position: GridCoord;
    isBase: boolean;
    energy: number;
    builds: number;
};

export type AttackerRef = {
    ship?: { name: string; side: Side } | null;
};

export type ShipMovedPayload = {
    shipName: string;
    side: Side;                    // e.g., "FEDERATION" | "EMPIRE"
    from: GridCoord;               // { v, h }
    to: GridCoord;                 // { v, h }
    distance: number;              // chebyshev or your chosen metric
    ts?: number;                   // optional event-local timestamp
    meta?: Record<string, unknown>;// optional extras
};

export function planetRef(p: Planet): PlanetRef {
    return {
        name: p.name,
        side: p.side,
        position: { v: p.position.v, h: p.position.h },
        isBase: !!p.isBase,
        energy: p.energy ?? 0,
        builds: p.builds ?? 0,
    };
}

export function attackerRef(by?: Player | null): AttackerRef | undefined {
    if (!by || !by.ship) return undefined;
    return { ship: { name: by.ship.name, side: by.ship.side } };
}

/** Canonical envelope for all events */
export type AnyEvent<T = unknown> = {
    id: number;        // monotonic id
    ts: number;        // epoch ms
    t: number;         // alias for old clients
    type: EventType;
    payload: T;
};

/* =========================
 * Event hub (buffer + SSE)
 * ========================= */

class EventHub {
    private buffer: AnyEvent[] = [];
    private subscribers = new Set<(e: AnyEvent) => void>();
    private lastId = 0;
    private readonly maxBuffer: number;

    constructor(maxBuffer: number = 5000) {
        this.maxBuffer = maxBuffer;
    }

    emit<E = unknown>(e: Omit<AnyEvent<E>, "id" | "ts" | "t"> & { type: EventType }): AnyEvent<E> {
        const evt: AnyEvent<E> = {
            ...e,
            id: ++this.lastId,
            ts: Date.now(),
            t: Date.now(),
        };
        this.buffer.push(evt);
        if (this.buffer.length > this.maxBuffer) this.buffer.shift();
        for (const cb of this.subscribers) cb(evt);
        return evt;
    }

    /** Subscribe; returns an unsubscribe function */
    subscribe(cb: (e: AnyEvent) => void): () => void {
        this.subscribers.add(cb);
        return () => this.subscribers.delete(cb);
    }

    /** Return events since id (exclusive). Optionally filter by types. */
    getSince(since?: number, types?: EventType[]): AnyEvent[] {
        const startIdx =
            since && Number.isFinite(since)
                ? Math.max(
                    0,
                    this.buffer.findIndex((e) => e.id > (since as number))
                )
                : 0;
        const sliced = this.buffer.slice(startIdx);
        if (!types || types.length === 0) return sliced;
        const set = new Set(types);
        return sliced.filter((e) => set.has(e.type));
    }

    /** Latest id in the buffer (0 if empty) */
    latestId(): number {
        return this.buffer.at(-1)?.id ?? 0;
    }
}

/** Singleton used across the server/game code */
export const gameEvents = new EventHub();

export function emitBaseBuilt(planet: Planet, by?: Player | null) {
    return gameEvents.emit({
        type: "base_built",          // legacy/back-compat event name
        payload: {
            planet: planetRef(planet),
            by: attackerRef(by),
        },
    });
}