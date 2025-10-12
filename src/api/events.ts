// src/api/events.ts
import { Side } from "../settings.js";
import { Planet } from "../planet.js";
import { Player } from "../player.js";

// src/api/events.ts  (only the union shown here)
export type EventType =
    | "ship_moved"
    | "phaser"
    | "torpedo"
    | "planet_hit"
    | "planet_builds_changed"
    | "planet_energy_changed"
    | "planet_captured"
    | "base_built"
    | "planet_base_removed"
    | "base_destroyed"
    | "score_changed"
    | (string & {});




// Back-compat alias for code that still imports GameEventType
export type GameEventType = EventType;


type GridCoord = { v: number; h: number };

export type ShipMovedPayload = {
    // identity
    shipName: string;         // e.g., "ENTERPRISE"
    side: "FEDERATION" | "EMPIRE" | "ROMULAN" | string;

    // movement
    from: GridCoord;          // previous position
    to: GridCoord;            // new position
    distance: number;         // Chebyshev or steps moved (your choice)

    // optional niceties
    ts?: number;              // server time (added by hub anyway)
    meta?: Record<string, unknown>;
};

/** Minimal public shape we send to clients for a planet */
export type PlanetRef = {
    name: string;
    side: Side;
    position: { v: number; h: number };
    isBase: boolean;
    energy: number; // 0..1000 for bases; may be 0 for non-bases
    builds: number; // non-bases only; 0..N
};

/** Minimal attacker info (player ship), optional */
export type AttackerRef = {
    ship?: { name: string; side: Side } | null;
};

function planetRef(p: Planet): PlanetRef {
    return {
        name: p.name,
        side: p.side,
        position: { v: p.position.v, h: p.position.h },
        isBase: !!p.isBase,
        energy: p.energy ?? 0,
        builds: p.builds ?? 0,
    };
}

function attackerRef(by?: Player | null): AttackerRef | undefined {
    if (!by || !by.ship) return undefined;
    return { ship: { name: by.ship.name, side: by.ship.side } };
}

// Include both ts and t (alias) so clients reading either will work.
export type AnyEvent<T = unknown> = {
    id: number;       // monotonically increasing
    ts: number;       // epoch ms
    t: number;        // epoch ms (alias for ts, for older clients)
    type: EventType;  // event name
    payload: T;       // event payload
};

type Listener = (e: AnyEvent) => void;

export class EventHub {
    private seq = 0;
    private listeners = new Set<Listener>();
    private buffer: AnyEvent[] = [];
    private readonly maxBuffer: number;

    constructor(maxBuffer = 1000) {
        this.maxBuffer = Math.max(1, maxBuffer);
    }

    /** Emit an event and fan it out to subscribers. */
    emit<T = unknown>(evt: Omit<AnyEvent<T>, "id" | "ts" | "t">): AnyEvent<T> {
        const now = Date.now();
        const e: AnyEvent<T> = {
            id: ++this.seq,
            ts: now,
            t: now,               // keep alias in sync
            type: evt.type,
            payload: evt.payload,
        };
        this.buffer.push(e);
        if (this.buffer.length > this.maxBuffer) this.buffer.shift();
        for (const l of this.listeners) {
            try {
                l(e);
            } catch {
                /* ignore listener errors */
            }
        }
        return e;
    }

    /** Subscribe; returns an unsubscribe function. */
    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * Get a backlog of events newer than `sinceId`.
     * Optionally filter by event types (Array or Set).
     * Back-compat name retained.
     */
    getSince(sinceId?: number, types?: EventType[] | Set<EventType>): AnyEvent[] {
        let out = sinceId ? this.buffer.filter(e => e.id > sinceId) : [...this.buffer];
        if (types && (Array.isArray(types) ? types.length : (types as Set<EventType>).size)) {
            const set = Array.isArray(types) ? new Set(types) : (types as Set<EventType>);
            out = out.filter(e => set.has(e.type));
        }
        return out;
    }

    /**
     * Snapshot helper used by the API. Same semantics as getSince,
     * but accepts Set or Array and returns a copy.
     */
    snapshot(sinceId?: number, types?: EventType[] | Set<EventType>): AnyEvent[] {
        return this.getSince(sinceId, types);
    }

    /** Latest emitted event id (0 if none). */
    latestId(): number {
        return this.seq;
    }

    /** Convenience for clearing during tests. */
    clear(): void {
        this.buffer.length = 0;
        this.seq = 0;
    }
}


/** Emit when a planet takes a hit (phaser/torpedo) */
export function emitPlanetHit(options: {
    planet: Planet;
    weapon: "phaser" | "torpedo";
    damage: number;         // final applied damage (to hull/energy)
    crit?: boolean;
    destroyed?: boolean;    // planet base destroyed this volley
    shieldBefore?: number;  // (optional) raw shield/energy before
    shieldAfter?: number;   // (optional) raw shield/energy after
    by?: Player | null;     // optional attacker
}) {
    const {
        planet, weapon, damage, crit = false, destroyed = false,
        shieldBefore, shieldAfter, by
    } = options;

    gameEvents.emit({
        type: "planet_hit",
        payload: {
            planet: planetRef(planet),
            weapon,
            damage: Math.round(damage),
            crit,
            destroyed,
            shieldBefore,
            shieldAfter,
            by: attackerRef(by),
        },
    });
}

/** Emit when planet builds count changes (non-base planets) */
export function emitPlanetBuildsChanged(options: {
    planet: Planet;
    delta: number;             // +1/-1/etc.
    newBuilds: number;
    reason?: string;           // optional note: "phaser", "event", etc.
    by?: Player | null;
}) {
    const { planet, delta, newBuilds, reason, by } = options;

    gameEvents.emit({
        type: "planet_builds_changed",
        payload: {
            planet: planetRef(planet),
            delta,
            newBuilds,
            reason,
            by: attackerRef(by),
        },
    });
}

/** Emit when base energy (0..1000) changes (e.g., drain/collapse) */
export function emitPlanetEnergyChanged(options: {
    planet: Planet;
    prev: number;
    next: number;
    reason?: string;           // "phaser_drain", "torp_deflect", etc.
    by?: Player | null;
}) {
    const { planet, prev, next, reason, by } = options;

    gameEvents.emit({
        type: "planet_energy_changed",
        payload: {
            planet: planetRef(planet),
            prev,
            next,
            reason,
            by: attackerRef(by),
        },
    });
}

/** Emit when a base is constructed on a planet */
export function emitBaseBuilt(options: {
    planet: Planet;
    by?: Player | null;
}) {
    const { planet, by } = options;

    gameEvents.emit({
        type: "base_built",
        payload: {
            planet: planetRef(planet),
            by: attackerRef(by),
        },
    });
}

/** Emit when a base is destroyed / removed from the map */
export function emitBaseDestroyed(options: {
    planet: Planet;
    by?: Player | null;
    reason?: "combat" | "collapse" | "script" | string;
}) {
    const { planet, by, reason = "combat" } = options;

    gameEvents.emit({
        type: "base_destroyed",
        payload: {
            planet: planetRef(planet),
            by: attackerRef(by),
            reason,
        },
    });
}

/** Optional: side flips due to conquest/capture */
export function emitPlanetCaptured(options: {
    planet: Planet;
    prevSide: Side;
    nextSide: Side;
    by?: Player | null;
}) {
    const { planet, prevSide, nextSide, by } = options;

    gameEvents.emit({
        type: "planet_captured",
        payload: {
            planet: planetRef(planet),
            prevSide,
            nextSide,
            by: attackerRef(by),
        },
    });
}
/** When a planet becomes a base(makeBase). */
export function emitPlanetBaseCreated(p: {
    id?: string | number;
    name?: string;
    side: string;
    position: { v: number; h: number };
    energy: number;
    builds?: number;
}) {
    gameEvents.emit({
        type: "planet_base_created",
        payload: {
            id: p.id ?? null,
            name: p.name ?? null,
            side: p.side,
            position: p.position,
            energy: p.energy,
            builds: p.builds ?? 0,
        },
    });
}


/**
 * When a base is removed (either destroyed by combat or demoted/admin action).
 * reason: "destroyed" | "demoted" | "manual"
 */
export function emitBaseRemoved(p: {
    id?: string | number;
    name?: string;
    side: string;
    position: { v: number; h: number };
    energy: number;
    builds?: number;
}, opts?: {
    reason?: "destroyed" | "demoted" | "manual";
    byPlayerId?: string | number;
    byShipName?: string;
}) {
    gameEvents.emit({
        type: "planet_base_removed",
        payload: {
            id: p.id ?? null,
            name: p.name ?? null,
            side: p.side,            // note: we keep the side for FORTRAN parity
            position: p.position,
            energy: p.energy,
            builds: p.builds ?? 0,
            reason: opts?.reason ?? "destroyed",
            byPlayerId: opts?.byPlayerId ?? null,
            byShipName: opts?.byShipName ?? null,
        },
    });
}

// Single shared hub for the whole app.
export const gameEvents = new EventHub(2000);
