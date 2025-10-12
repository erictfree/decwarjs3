// src/api/events.ts
import type { Player } from "../player.js";
import type { Planet } from "../planet.js";
import type { Side } from "../settings.js";

/* =========================
 * Public event catalog/types
 * ========================= */

export type EventType =
    // existing
    | "ship_moved"
    | "phaser"
    | "torpedo"
    | "planet_hit"
    | "planet_builds_changed"
    | "planet_energy_changed"
    | "planet_captured"
    | "base_built" // kept for back-compat with emitBaseBuilt()
    | "planet_base_created"
    | "planet_base_removed"
    | "base_destroyed"
    | "score_changed"
    // NEW ship lifecycle
    | "ship_joined" // a player takes control of a ship (boards/assigns)
    | "ship_left" // a player releases a ship (logs out/docks/AFK/etc.)
    | "ship_destroyed" // a ship is actually removed from the world
    | "ship_docked"      // ← NEW
    | "ship_undocked";   // ← NEW

// --- payloads ---
export type DockReason = "manual" | "auto" | "repair" | "resupply";
export type UndockReason = "manual" | "launch" | "forced" | "base_destroyed" | "nova";


export type GridCoord = { v: number; h: number };


export type ShipDockedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;         // planet/base coords
    planet: PlanetRef;     // snapshot for clients
    player: string;        // display name (player or ship fallback)
    reason?: DockReason;
};

export type ShipUndockedPayload = {
    shipName: string;
    side: Side;
    from: GridCoord;       // planet/base coords
    planet: PlanetRef;     // snapshot for clients
    player: string;        // display name (player or ship fallback)
    reason?: UndockReason;
};

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
    side: Side; // e.g., "FEDERATION" | "EMPIRE"
    from: GridCoord; // { v, h }
    to: GridCoord; // { v, h }
    distance: number; // chebyshev or your chosen metric
    ts?: number; // optional event-local timestamp
    meta?: Record<string, unknown>; // optional extras
};

// NEW — when a player takes control of a ship
export type ShipJoinedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    player: string; // player name (who boarded/was assigned)
    reason?: "assign" | "launch" | "reconnect" | "manual";
};

// NEW — when a player releases a ship (ship remains parked/available)
export type ShipLeftPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    player: string; // player name (who left/released)
    reason?:
    | "logout"
    | "dock"
    | "timeout"
    | "idle"
    | "manual"
    | "disconnect" // ← added
    | "endgame"; // ← added
};

// NEW — when a ship is actually removed from the world (rare; use only if you truly delete it)
export type ShipDestroyedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    by?: AttackerRef; // who caused it (if applicable)
    cause?: "combat" | "planet" | "blackhole" | "self" | "other";
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

// payload type
export type PlanetCapturedPayload = {
    planet: PlanetRef;
    prevSide: Side;
    nextSide: Side;
    by?: AttackerRef;
};

/** Canonical envelope for all events */
export type AnyEvent<T = unknown> = {
    id: number; // monotonic id
    ts: number; // epoch ms
    t: number; // alias for old clients
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
        const now = Date.now();
        const evt: AnyEvent<E> = {
            ...e,
            id: ++this.lastId,
            ts: now,
            t: now,
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
                ? Math.max(0, this.buffer.findIndex((e) => e.id > (since as number)))
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

/* =========================
 * Emit helpers
 * ========================= */

export function emitBaseBuilt(planet: Planet, by?: Player | null) {
    return gameEvents.emit({
        type: "base_built", // legacy/back-compat event name
        payload: {
            planet: planetRef(planet),
            by: attackerRef(by),
        },
    });
}

export function emitPlanetCaptured(planet: Planet, prevSide: Side, nextSide: Side, by?: Player | null) {
    return gameEvents.emit<PlanetCapturedPayload>({
        type: "planet_captured",
        payload: {
            planet: planetRef(planet),
            prevSide,
            nextSide,
            by: attackerRef(by),
        },
    });
}

// NEW — ship lifecycle helpers

export function emitShipJoined(player: Player, reason: ShipJoinedPayload["reason"] = "assign") {
    if (!player.ship) return;
    const { ship } = player;

    const payload: ShipJoinedPayload = {
        shipName: ship.name,
        side: ship.side,
        at: ship.position,
        player: displayName(player), // uses player name, then ship name
        reason,
    };

    return gameEvents.emit<ShipJoinedPayload>({ type: "ship_joined", payload });
}

export function emitShipLeft(player: Player, reason: ShipLeftPayload["reason"] = "logout") {
    if (!player.ship) return;
    const { ship } = player;

    const payload: ShipLeftPayload = {
        shipName: ship.name,
        side: ship.side,
        at: ship.position,
        player: displayName(player), // uses player name, then ship name
        reason,
    };

    return gameEvents.emit<ShipLeftPayload>({ type: "ship_left", payload });
}

export function emitShipDestroyed(
    shipName: string,
    side: Side,
    at: GridCoord,
    by?: AttackerRef,
    cause: ShipDestroyedPayload["cause"] = "combat",
) {
    return gameEvents.emit<ShipDestroyedPayload>({
        type: "ship_destroyed",
        payload: { shipName, side, at, by, cause },
    });
}

/* =========================
 * Utilities
 * ========================= */

function displayName(player: Player): string {
    const n = player.settings?.name ?? player.ship?.name ?? "unknown";
    return typeof n === "string" && n.trim().length > 0 ? n : "unknown";
}

// --- emitters ---
export function emitShipDocked(
    player: Player,
    planet: Planet,
    reason: DockReason = "manual",
) {
    if (!player.ship) return;
    return gameEvents.emit<ShipDockedPayload>({
        type: "ship_docked",
        payload: {
            shipName: player.ship.name,
            side: player.ship.side,
            at: { ...planet.position },
            planet: planetRef(planet),
            player: displayName(player),
            reason,
        },
    });
}

export function emitShipUndocked(
    player: Player,
    planet: Planet,
    reason: UndockReason = "manual",
) {
    if (!player.ship) return;
    return gameEvents.emit<ShipUndockedPayload>({
        type: "ship_undocked",
        payload: {
            shipName: player.ship.name,
            side: player.ship.side,
            from: { ...planet.position },
            planet: planetRef(planet),
            player: displayName(player),
            reason,
        },
    });
}