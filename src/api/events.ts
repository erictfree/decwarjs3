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
    | "ship_docked"
    | "ship_undocked"
    | "nova_triggered"
    | "object_displaced"
    | "shields_toggled"
    | "ship_hit"
    | "ship_hull_changed"
    | "shields_changed"
    | "collapse_phaser"
    | "collapse_torpedo"
    | "base_destroyed"
    | "planet_hit"
    | "comms"
    | "romulan_spawned"
    | "romulan_cloak_toggled"
    | "romulan_moved"
    | "romulan_target_acquired"
    | "romulan_phaser"
    | "romulan_torpedo"
    | "romulan_energy_changed"
    | "romulan_destroyed"
    | "romulan_comms"
    | "other";

// --- payloads ---
export type DockReason = "manual" | "auto" | "repair" | "resupply";
export type UndockReason = "manual" | "launch" | "forced" | "base_destroyed" | "nova" | "other" | "blackhole";


// --- Recipient type for comms ---
export type CommsRecipient =
    | { kind: "GLOBAL" }
    | { kind: "SIDE"; side: Side }
    | { kind: "SHIP"; shipName: string; side: Side };

export type CommsEventPayload = {
    id: string;                     // server-generated message id (uuid or short id)
    at: number;                     // Date.now()
    from: { shipName: string; side: Side };
    to: CommsRecipient;
    text: string;                   // raw text as sent
};



export type GridCoord = { v: number; h: number };

export type NovaTriggeredPayload = {
    at: GridCoord;              // where the nova detonated
    by?: AttackerRef;           // who caused it (torp shooter)
};

/** Generic displacement (nova shockwave, blackhole, etc.) */
export function emitObjectDisplaced(
    kind: ObjectDisplacedPayload["kind"],
    name: string | undefined,
    from: GridCoord,
    to: GridCoord,
    reason: ObjectDisplacedPayload["reason"] = "nova"
) {
    return gameEvents.emit<ObjectDisplacedPayload>({
        type: "object_displaced",
        payload: { kind, name, from, to, reason },
    });
}


export type TargetRef =
    | { kind: "ship"; name: string; side: Side; position: GridCoord }
    | { kind: "base"; name: string; side: Side; position: GridCoord }
    | { kind: "planet"; name: string; side: Side; position: GridCoord }
    | { kind: "star"; position: GridCoord }
    | { kind: "blackhole"; position: GridCoord };


export type PhaserEventPayload = {
    by: { shipName: string; side: Side };
    from: GridCoord;
    to: GridCoord;                   // aimed sector
    distance: number;
    energySpent: number;             // actual energy consumed
    target?: TargetRef;              // resolved target (if any)
    result: "hit" | "miss" | "no_effect" | "friendly_block" | "out_of_range" | "no_target";
    damage?: number;                 // hull/energy that got through shields
    shieldsBefore?: number;          // target shields/energy store (ship: 0..MAX, base: 0..1000)
    shieldsAfter?: number;
    crit?: { device?: string; amount?: number } | null;
    killed?: boolean;                // ship/base destroyed as a result of this phaser
};

export type TorpedoEventPayload = {
    by: { shipName: string; side: Side };
    from: GridCoord;
    // what the shooter asked for
    aim: GridCoord;
    // what actually happened
    collision:
    | { kind: "ship"; name: string; side: Side; position: GridCoord }
    | { kind: "base"; name: string; side: Side; position: GridCoord }
    | { kind: "planet"; name: string; side: Side; position: GridCoord }
    | { kind: "star"; position: GridCoord }
    | { kind: "blackhole"; position: GridCoord }
    | { kind: "boundary"; position: GridCoord }
    | { kind: "none" };
    result: "hit" | "deflected" | "no_effect" | "out_of_range" | "self_target" | "fizzled";
    damage?: number;                 // applied hull/base damage (post-shield scaling)
    crit?: { device?: string; amount?: number } | null;
    shieldsBefore?: number;
    shieldsAfter?: number;
    killed?: boolean;                // ship/base destroyed by this torpedo
    novaTriggered?: boolean;         // if your torp set off a nova
};

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

export type PlanetBaseRemovedReason =
    | "collapse_phaser"
    | "collapse_torpedo"
    | "base_destroyed"
    | "other";

export type PlanetBaseRemovedPayload = {
    planet: PlanetRef;              // current snapshot after removal
    by?: AttackerRef;               // optional
    reason?: PlanetBaseRemovedReason;
    previousSide?: Side;            // who owned it before
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




export type ObjectDisplacedPayload = {
    kind: "ship" | "planet" | "base";
    name?: string; // ← make optional
    from: GridCoord;
    to: GridCoord;
    reason: "nova" | "blackhole" | "other";
};

export function emitPhaserEvent(payload: PhaserEventPayload) {
    return gameEvents.emit<PhaserEventPayload>({ type: "phaser", payload });
}

// export function emitTorpedoEvent(payload: TorpedoEventPayload) {
//     return gameEvents.emit<TorpedoEventPayload>({ type: "torpedo", payload });
// }

// export function emitTorpedoEvent(payload: TorpedoEventPayload) {
//     return gameEvents.emit<TorpedoEventPayload>({ type: "torpedo", payload });
// }


export function emitNovaTriggered(at: GridCoord, by?: Player | null) {
    return gameEvents.emit<NovaTriggeredPayload>({
        type: "nova_triggered",
        payload: { at, by: attackerRef(by ?? undefined) },
    });
}



export type ShieldsToggledPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    up: boolean;                 // true = raised, false = lowered
    shieldEnergy: number;        // current energy after the toggle
    delta?: { before: number; after: number }; // optional, if caller provides it
};


export function emitShieldsToggled(
    player: Player,
    up: boolean,
    delta?: { before: number; after: number }
) {
    if (!player.ship) return;
    return gameEvents.emit<ShieldsToggledPayload>({
        type: "shields_toggled",
        payload: {
            shipName: player.ship.name,
            side: player.ship.side,
            at: { v: player.ship.position.v, h: player.ship.position.h },
            up,
            shieldEnergy: player.ship.shieldEnergy,
            ...(delta ? { delta } : {}),
        },
    });
}


/* ========= DAMAGE EVENTS ========= */

export type WeaponKind = "phaser" | "torpedo" | "nova" | "collision" | "other";

/** Per-impact record when a ship takes damage (post-shield, hull applied) */
export type ShipHitPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;

    by?: AttackerRef;             // who dealt the hit (if applicable)
    weapon: WeaponKind;

    amount: number;               // hull damage actually applied (>=0)
    crit?: { device?: string; amount?: number } | null;

    shieldsBefore?: number;       // target shield/energy store BEFORE the hit (ship)
    shieldsAfter?: number;        // …and AFTER
    shieldsUpBefore?: boolean;    // convenience (if you track it)
    shieldsUpAfter?: boolean;

    killed?: boolean;             // ship destroyed as a result
};



/** Planet/base damage (you already have type "planet_hit"; here’s a helper) */
export type PlanetHitPayload = {
    planet: PlanetRef;
    weapon: WeaponKind;
    damage: number;               // hull/energy removed
    destroyed?: boolean;          // base destroyed/planet disabled
    by?: AttackerRef;
};

export function emitShipHit(
    target: Player,
    weapon: WeaponKind,
    amount: number,
    opts?: {
        by?: Player | null;
        crit?: { device?: string; amount?: number } | null;
        shieldsBefore?: number;
        shieldsAfter?: number;
        shieldsUpBefore?: boolean;
        shieldsUpAfter?: boolean;
        killed?: boolean;
    }
) {
    if (!target.ship) return;
    const {
        by = undefined,
        crit = null,
        shieldsBefore,
        shieldsAfter,
        shieldsUpBefore,
        shieldsUpAfter,
        killed,
    } = opts || {};
    return gameEvents.emit<ShipHitPayload>({
        type: "ship_hit",
        payload: {
            shipName: target.ship.name,
            side: target.ship.side,
            at: { ...target.ship.position },
            by: attackerRef(by ?? undefined),
            weapon,
            amount: Math.max(0, Math.round(amount)),
            crit,
            shieldsBefore,
            shieldsAfter,
            shieldsUpBefore,
            shieldsUpAfter,
            killed: !!killed,
        },
    });
}

export type ShipHullChangedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    energyBefore: number;
    energyAfter: number;
    damageBefore: number;
    damageAfter: number;
    reason: "phaser" | "torpedo" | "nova" | "collision" | "other";
    by?: AttackerRef;
};

export function emitShipHullChanged(
    victim: Player,
    energyBefore: number,
    energyAfter: number,
    damageBefore: number,
    damageAfter: number,
    reason: ShipHullChangedPayload["reason"],
    byPlayer?: Player | null
) {
    if (!victim.ship) return;
    return gameEvents.emit<ShipHullChangedPayload>({
        type: "ship_hull_changed",
        payload: {
            shipName: victim.ship.name,
            side: victim.ship.side,
            at: { v: victim.ship.position.v, h: victim.ship.position.h },
            energyBefore,
            energyAfter,
            damageBefore,
            damageAfter,
            reason,
            by: attackerRef(byPlayer ?? undefined),
        },
    });
}


export function emitPlanetHit(
    planet: Planet,
    weapon: WeaponKind,
    damage: number,
    destroyed?: boolean,
    by?: Player | null
) {
    return gameEvents.emit<PlanetHitPayload>({
        type: "planet_hit",
        payload: {
            planet: planetRef(planet),
            weapon,
            damage: Math.max(0, Math.round(damage)),
            destroyed: !!destroyed,
            by: attackerRef(by ?? undefined),
        },
    });
}

export function emitShieldsChanged(p: Player, before: number, after: number) {
    if (!p.ship) return;
    if (before === after) return;
    return gameEvents.emit<ShieldsChangedPayload>({
        type: "shields_changed",
        payload: {
            shipName: p.ship.name,
            side: p.ship.side,
            at: { v: p.ship.position.v, h: p.ship.position.h },
            before,
            after,
        },
    });
}

export type ShieldsChangedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    before: number;
    after: number;
};

export function emitPlanetBaseRemoved(
    planet: Planet,
    reason: PlanetBaseRemovedReason = "other",
    by?: Player | null,
    previousSide?: Side
) {
    return gameEvents.emit<PlanetBaseRemovedPayload>({
        type: "planet_base_removed",
        payload: {
            planet: planetRef(planet),
            by: attackerRef(by ?? undefined),
            reason,
            previousSide,
        },
    });
}


const msgId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function emitComms(from: Player, to: CommsRecipient, text: string) {
    if (!from.ship) return;
    gameEvents.emit({
        type: "comms",
        payload: {
            id: msgId(),
            at: Date.now(),
            from: attackerRef(from),   // { shipName, side }
            to,
            text,
        },
    });
}

// --- Emitter helper ---
export function emitCommsSent(
    from: Player,
    to: CommsRecipient,
    text: string,
    id?: string
): void {
    if (!from.ship) return;
    const payload: CommsEventPayload = {
        id: id ?? Math.random().toString(36).slice(2), // replace with your uuid if you prefer
        at: Date.now(),
        from: { shipName: from.ship.name, side: from.ship.side },
        to,
        text,
    };
    gameEvents.emit({ type: "comms", payload });
}

// --- Romulan payloads
export type RomulanSpawnedPayload = { at: GridCoord; erom: number };
export type RomulanCloakToggledPayload = { at: GridCoord; cloaked: boolean };
export type RomulanMovedPayload = { from: GridCoord; to: GridCoord; distance: number };
export type RomulanTargetAcquiredPayload =
    { target: TargetRef; distance: number };
export type RomulanWeaponPayload = {
    from: GridCoord; to: GridCoord; distance: number; damage?: number;
};
export type RomulanEnergyChangedPayload = { before: number; after: number; reason: "phaser_hit" | "torpedo_hit" | "other" };
export type RomulanDestroyedPayload = { at: GridCoord; by?: AttackerRef };

// --- Romulan emit helpers
export const emitRomulanSpawned = (at: GridCoord, erom: number) =>
    gameEvents.emit<RomulanSpawnedPayload>({ type: "romulan_spawned", payload: { at, erom } });

export const emitRomulanCloakToggled = (at: GridCoord, cloaked: boolean) =>
    gameEvents.emit<RomulanCloakToggledPayload>({ type: "romulan_cloak_toggled", payload: { at, cloaked } });

export const emitRomulanMoved = (from: GridCoord, to: GridCoord, distance: number) =>
    gameEvents.emit<RomulanMovedPayload>({ type: "romulan_moved", payload: { from, to, distance } });

export const emitRomulanTarget = (target: TargetRef, distance: number) =>
    gameEvents.emit<RomulanTargetAcquiredPayload>({ type: "romulan_target_acquired", payload: { target, distance } });

export const emitRomulanPhaser = (p: RomulanWeaponPayload) =>
    gameEvents.emit<RomulanWeaponPayload>({ type: "romulan_phaser", payload: p });

export const emitRomulanTorpedo = (p: RomulanWeaponPayload) =>
    gameEvents.emit<RomulanWeaponPayload>({ type: "romulan_torpedo", payload: p });

export const emitRomulanEnergyChanged = (before: number, after: number, reason: RomulanEnergyChangedPayload["reason"]) =>
    gameEvents.emit<RomulanEnergyChangedPayload>({ type: "romulan_energy_changed", payload: { before, after, reason } });

export const emitRomulanDestroyed = (at: GridCoord, by?: AttackerRef) =>
    gameEvents.emit<RomulanDestroyedPayload>({ type: "romulan_destroyed", payload: { at, by } });

export const emitRomulanComms = (text: string, at: GridCoord) =>
    gameEvents.emit<{ at: GridCoord; text: string }>({ type: "romulan_comms", payload: { at, text } });
