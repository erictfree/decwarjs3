// src/api/events.ts
import type { Player } from "../player.js";
import type { Planet } from "../planet.js";
import type { Side } from "../settings.js";

/* =========================
 * Public event catalog/types
 * ========================= */

export type EventType =
    // movement & combat
    | "ship_moved"
    | "phaser"
    | "torpedo"
    | "collapse_phaser"
    | "collapse_torpedo"
    | "ship_hit"
    | "ship_hull_changed"
    // planets/bases
    | "planet_hit"
    | "planet_builds_changed"
    | "planet_energy_changed"
    | "planet_captured"
    | "base_built"             // kept for back-compat with emitBaseBuilt()
    | "planet_base_created"
    | "planet_base_removed"
    | "base_destroyed"
    | "score_changed"
    // ship lifecycle
    | "ship_joined"
    | "ship_left"
    | "ship_destroyed"
    | "ship_docked"
    | "ship_undocked"
    // misc world
    | "nova_triggered"
    | "object_displaced"
    // shields (two complementary signals)
    | "shields_toggled"        // up/down + ship energy snapshot (for logs/UI)
    | "shields_changed"        // numeric pool change before/after
    // comms
    | "comms"
    // romulan
    | "romulan_spawned"
    | "romulan_cloak_toggled"
    | "romulan_moved"
    | "romulan_target_acquired"
    | "romulan_phaser"
    | "romulan_torpedo"
    | "romulan_energy_changed"
    | "romulan_destroyed"
    | "romulan_comms"
    // fallback
    | "other";

// --- simple shared shapes ---
export type GridCoord = { v: number; h: number };

export type PlanetRef = {
    name: string;
    side: Side;
    position: GridCoord;
    isBase: boolean;
    energy: number;
    builds: number;
};

export type ShipRef = { shipName: string; side: Side };

export type AttackerRef = {
    ship?: ShipRef | null;
};

// --- targeting union for weapon events ---
export type TargetRef =
    | { kind: "ship"; name: string; side: Side; position: GridCoord }
    | { kind: "base"; name: string; side: Side; position: GridCoord }
    | { kind: "planet"; name: string; side: Side; position: GridCoord }
    | { kind: "star"; position: GridCoord }
    | { kind: "blackhole"; position: GridCoord };

/* =========================
 * Event payload types
 * ========================= */

export type DockReason = "manual" | "auto" | "repair" | "resupply";
export type UndockReason = "manual" | "launch" | "forced" | "base_destroyed" | "nova" | "other" | "blackhole";

export type CommsRecipient =
    | { kind: "GLOBAL" }
    | { kind: "SIDE"; side: Side }
    | { kind: "SHIP"; shipName: string; side: Side };

export type CommsEventPayload = {
    id: string;          // server-generated id
    at: number;          // Date.now()
    from: ShipRef;       // { shipName, side }
    to: CommsRecipient;
    text: string;
};

export type NovaTriggeredPayload = {
    at: GridCoord;              // where the nova detonated
    radius: number;             // display-friendly radius
    by?: AttackerRef;           // who caused it (torp shooter)
};

export type ObjectDisplacedPayload = {
    kind: "ship" | "planet" | "base";
    name?: string;       // optional
    from: GridCoord;
    to: GridCoord;
    reason: "nova" | "blackhole" | "other";
};

export type PhaserEventPayload = {
    by: ShipRef;
    from: GridCoord;
    to: GridCoord;                 // aimed sector
    distance: number;
    energySpent: number;           // actual energy consumed
    target?: TargetRef;            // resolved target (if any)
    result: "hit" | "miss" | "no_effect" | "friendly_block" | "out_of_range" | "no_target";
    damage?: number;               // post-shield hull damage
    shieldsBefore?: number;        // target shield pool (ship/base)
    shieldsAfter?: number;
    crit?: { device?: string; amount?: number } | null;
    killed?: boolean;
};

export type TorpedoEventPayload = {
    by: ShipRef;
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
    distance?: number;             // Chebyshev distance resolved (normalized in emit)
    damage?: number;               // applied hull/base damage (normalized in emit)
    crit?: { device?: string; amount?: number } | null;
    shieldsBefore?: number;
    shieldsAfter?: number;
    killed?: boolean;
    novaTriggered?: boolean;
};

export type ShipMovedPayload = {
    shipName: string;
    side: Side;
    from: GridCoord;
    to: GridCoord;
    distance: number;   // chebyshev
    ts?: number;
    meta?: Record<string, unknown>;
};

export type ShipDockedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;      // planet/base coords
    planet: PlanetRef;
    player: string;     // display name
    reason?: DockReason;
};

export type ShipUndockedPayload = {
    shipName: string;
    side: Side;
    from: GridCoord;    // planet/base coords
    planet: PlanetRef;
    player: string;
    reason?: UndockReason;
};

export type ShipJoinedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    player: string;
    reason?: "assign" | "launch" | "reconnect" | "manual";
};

export type ShipLeftPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    player: string;
    reason?: "logout" | "dock" | "timeout" | "idle" | "manual" | "disconnect" | "endgame";
};

export type PlanetCapturedPayload = {
    planet: PlanetRef;
    prevSide: Side;
    nextSide: Side;
    by?: AttackerRef;
};

export type PlanetBaseRemovedReason =
    | "collapse_phaser"
    | "collapse_torpedo"
    | "base_destroyed"
    | "other";

export type PlanetBaseRemovedPayload = {
    planet: PlanetRef;
    by?: AttackerRef;
    reason?: PlanetBaseRemovedReason;
    previousSide?: Side;
};

export type ShipDestroyedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    by?: AttackerRef;
    cause?: "combat" | "planet" | "blackhole" | "self" | "other";
};

export type WeaponKind = "phaser" | "torpedo" | "nova" | "collision" | "other";

/** Per-impact record when a ship takes damage (post-shield, hull applied) */
export type ShipHitPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    by?: AttackerRef;
    weapon: WeaponKind;
    amount: number;                 // >= 0 (rounded)
    crit?: { device?: string; amount?: number } | null;
    shieldsBefore?: number;
    shieldsAfter?: number;
    shieldsUpBefore?: boolean;
    shieldsUpAfter?: boolean;
    killed?: boolean;
};

/** Planet/base damage */
export type PlanetHitPayload = {
    planet: PlanetRef;
    weapon: WeaponKind;
    damage: number;
    destroyed?: boolean;
    by?: AttackerRef;
};

/** Numeric hull/energy deltas on a ship (coarse summary) */
export type ShipHullChangedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    energyBefore: number;
    energyAfter: number;
    damageBefore: number;
    damageAfter: number;
    reason: WeaponKind;
    by?: AttackerRef;
};

/** Discrete shield toggle (UP/DOWN) — carries `up` and ship energy */
export type ShieldsToggledPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    up: boolean;                  // true = raised, false = lowered
    shipEnergy: number;           // after toggle
    energy?: number;              // legacy alias for loggers (same as shipEnergy)
    shieldEnergy: number;         // shield pool after toggle
    delta?: { before: number; after: number }; // optional if caller provides
};

/** Numeric shield pool change (any cause) */
export type ShieldsChangedPayload = {
    shipName: string;
    side: Side;
    at: GridCoord;
    before: number;
    after: number;
    // Compat fields for legacy loggers that expect these on shields_changed:
    up?: boolean;        // mirrors current ship.shieldsUp
    energy?: number;     // mirrors current ship.energy (post-change snapshot)
};

/* =========================
 * Canonical envelope
 * ========================= */

export type AnyEvent<T = unknown> = {
    id: number;   // monotonic id
    ts: number;   // epoch ms
    t: number;    // alias for old clients
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
        const evt: AnyEvent<E> = { ...e, id: ++this.lastId, ts: now, t: now };
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

function shipRef(player: Player | null | undefined): ShipRef | undefined {
    if (!player?.ship) return undefined;
    return { shipName: player.ship.name, side: player.ship.side };
}

export function attackerRef(by?: Player | null): AttackerRef | undefined {
    const s = shipRef(by ?? undefined);
    if (!s) return undefined;
    return { ship: s };
}

function displayName(player: Player): string {
    const n = player.settings?.name ?? player.ship?.name ?? "unknown";
    return typeof n === "string" && n.trim().length > 0 ? n : "unknown";
}

export function emitBaseBuilt(planet: Planet, by?: Player | null) {
    return gameEvents.emit({
        type: "base_built",
        payload: { planet: planetRef(planet), by: attackerRef(by) },
    });
}

export function emitPlanetCaptured(planet: Planet, prevSide: Side, nextSide: Side, by?: Player | null) {
    return gameEvents.emit<PlanetCapturedPayload>({
        type: "planet_captured",
        payload: { planet: planetRef(planet), prevSide, nextSide, by: attackerRef(by) },
    });
}

// ship lifecycle
export function emitShipJoined(player: Player, reason: ShipJoinedPayload["reason"] = "assign") {
    if (!player.ship) return;
    return gameEvents.emit<ShipJoinedPayload>({
        type: "ship_joined",
        payload: {
            shipName: player.ship.name,
            side: player.ship.side,
            at: player.ship.position,
            player: displayName(player),
            reason,
        },
    });
}

export function emitShipLeft(player: Player, reason: ShipLeftPayload["reason"] = "logout") {
    if (!player.ship) return;
    return gameEvents.emit<ShipLeftPayload>({
        type: "ship_left",
        payload: {
            shipName: player.ship.name,
            side: player.ship.side,
            at: player.ship.position,
            player: displayName(player),
            reason,
        },
    });
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

// docking
export function emitShipDocked(player: Player, planet: Planet, reason: DockReason = "manual") {
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

export function emitShipUndocked(player: Player, planet: Planet, reason: UndockReason = "manual") {
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

// generic displacement
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

// combat emitters
export function emitPhaserEvent(payload: PhaserEventPayload) {
    return gameEvents.emit<PhaserEventPayload>({ type: "phaser", payload });
}

export function emitTorpedoEvent(payload: TorpedoEventPayload) {
    // --- normalize so loggers never see undefined ---
    // Compute end position for distance: prefer collision.position, else aim
    const from = payload.from;
    const endPos =
        (payload as any)?.collision?.position
            ? (payload as any).collision.position as GridCoord
            : payload.aim;

    // Chebyshev distance (no import to avoid cycles)
    const dv = Math.abs((endPos?.v ?? from.v) - from.v);
    const dh = Math.abs((endPos?.h ?? from.h) - from.h);
    const distance = Math.max(0, Math.round(payload.distance ?? Math.max(dv, dh)));

    const damage = Math.max(0, Math.round(payload.damage ?? 0));

    // Derive a sensible result if missing
    let result = payload.result;
    if (!result) {
        const k = (payload as any)?.collision?.kind;
        if (k === "boundary") result = "out_of_range";
        else if (k === "none") result = "fizzled";
        else if (damage > 0) result = "hit";
        else result = "no_effect";
    }

    return gameEvents.emit<TorpedoEventPayload>({
        type: "torpedo",
        payload: { ...payload, distance, damage, result },
    });
}


// nova
// If you have a canonical radius constant, import and use it.
// import { NOVA_RADIUS } from "../settings.js";
export function emitNovaTriggered(at: GridCoord, by?: Player | null, radius: number = 5) {
    return gameEvents.emit<NovaTriggeredPayload>({
        type: "nova_triggered",
        payload: { at, radius, by: attackerRef(by ?? undefined) },
    });
}

// shields
export function emitShieldsToggled(
    player: Player,
    up: boolean,
    delta?: { before: number; after: number }
) {
    if (!player.ship) return;
    const shipEnergy = player.ship.energy ?? 0;
    return gameEvents.emit<ShieldsToggledPayload>({
        type: "shields_toggled",
        payload: {
            shipName: player.ship.name,
            side: player.ship.side,
            at: { v: player.ship.position.v, h: player.ship.position.h },
            up,
            shipEnergy,
            energy: shipEnergy, // legacy alias – keeps existing logs happy
            shieldEnergy: player.ship.shieldEnergy,
            ...(delta ? { delta } : {}),
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
            // fill compat fields so loggers never see `undefined`
            up: p.ship.shieldsUp === true,
            energy: p.ship.energy ?? 0,
        },
    });
}

// damage summaries
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
            by: attackerRef(by),
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
            by: attackerRef(byPlayer),
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
            by: attackerRef(by),
        },
    });
}

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
            by: attackerRef(by),
            reason,
            previousSide,
        },
    });
}

/* =========================
 * Comms
 * ========================= */

const msgId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function emitComms(from: Player, to: CommsRecipient, text: string) {
    if (!from.ship) return;
    gameEvents.emit<CommsEventPayload>({
        type: "comms",
        payload: {
            id: msgId(),
            at: Date.now(),
            from: { shipName: from.ship.name, side: from.ship.side },
            to,
            text,
        },
    });
}

export function emitCommsSent(from: Player, to: CommsRecipient, text: string, id?: string): void {
    if (!from.ship) return;
    const payload: CommsEventPayload = {
        id: id ?? msgId(),
        at: Date.now(),
        from: { shipName: from.ship.name, side: from.ship.side },
        to,
        text,
    };
    gameEvents.emit({ type: "comms", payload });
}

/* =========================
 * Romulan
 * ========================= */

export type RomulanSpawnedPayload = { at: GridCoord; erom: number };
export type RomulanCloakToggledPayload = { at: GridCoord; cloaked: boolean };
export type RomulanMovedPayload = { from: GridCoord; to: GridCoord; distance: number };
export type RomulanTargetAcquiredPayload = { target: TargetRef; distance: number };
export type RomulanWeaponPayload = { from: GridCoord; to: GridCoord; distance: number; damage?: number };
export type RomulanEnergyChangedPayload = { before: number; after: number; reason: "phaser_hit" | "torpedo_hit" | "other" };
export type RomulanDestroyedPayload = { at: GridCoord; by?: AttackerRef };

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
