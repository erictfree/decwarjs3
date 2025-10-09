// src/api/events.ts
import type { Side } from "../settings.js";

export interface Coords { readonly v: number; readonly h: number; }

export type ActorKind = "player" | "base" | "planet" | "romulan";
export interface ActorRef {
    readonly kind: ActorKind;
    readonly name: string;
    readonly side: Side;
    readonly position: Coords;
}

export interface EventMap {
    player_joined: { readonly player: ActorRef };
    player_left: { readonly playerName: string; readonly side: Side };
    ship_moved: { readonly player: ActorRef; readonly from: Coords; readonly to: Coords };

    phaser: {
        readonly attacker: ActorRef;
        readonly target: ActorRef;
        readonly hit: number;
        readonly crit: boolean;
        readonly destroyed: boolean;
    };

    torpedo: {
        readonly attacker: ActorRef;
        readonly target: ActorRef;
        readonly hit: number;
        readonly deflected: boolean;
        readonly destroyed: boolean;
    };

    planet_captured: {
        readonly planet: ActorRef; // kind=planet
        readonly oldSide: Side;
        readonly newSide: Side;
    };

    base_destroyed: { readonly planet: ActorRef; readonly by: ActorRef };
    romulan_spawn: { readonly position: Coords };
    romulan_destroyed: { readonly position: Coords };
    message: { readonly to?: ActorRef; readonly from?: ActorRef; readonly text: string };
}

// Discriminated union of all events
export type AnyEvent =
    { [K in keyof EventMap]: Readonly<{ id: number; ts: number; type: K; data: EventMap[K] }> }[keyof EventMap];

type Subscriber = (e: AnyEvent) => void;

const DEFAULT_RING_SIZE = 2000;

export class GameEventBus {
    private nextId = 1;
    private readonly ring: (AnyEvent | undefined)[];
    private head = 0; // points to next write position
    private readonly subs = new Set<Subscriber>();

    constructor(private readonly capacity = DEFAULT_RING_SIZE) {
        this.ring = new Array<AnyEvent | undefined>(capacity);
    }

    publish<K extends keyof EventMap>(type: K, data: EventMap[K], ts?: number): AnyEvent {
        const evt: AnyEvent = Object.freeze({
            id: this.nextId++,
            ts: ts ?? Date.now(),
            type,
            data,
        } as AnyEvent);

        this.ring[this.head] = evt;
        this.head = (this.head + 1) % this.capacity;

        // notify subscribers
        for (const s of this.subs) s(evt);
        return evt;
    }

    subscribe(fn: Subscriber): () => void {
        this.subs.add(fn);
        return () => { this.subs.delete(fn); };
    }

    /**
     * Return events with id > sinceId (if provided), optionally filtered by types.
     * Results are in ascending id order.
     */
    getSince(sinceId?: number, types?: ReadonlyArray<keyof EventMap>): ReadonlyArray<AnyEvent> {
        const result: AnyEvent[] = [];
        const filter = types ? new Set(types) : null;

        // scan ring; because it’s circular, read oldest..newest by id
        // find minimal id present
        const items = this.ring.filter(Boolean) as AnyEvent[];
        if (items.length === 0) return result;

        // sort by id — ring capacity is small, O(n log n) is fine; keeps code simple & safe
        items.sort((a, b) => a.id - b.id);

        for (const e of items) {
            if (sinceId !== undefined && e.id <= sinceId) continue;
            if (filter && !filter.has(e.type)) continue;
            result.push(e);
        }
        return result;
    }

    latestId(): number {
        const items = this.ring.filter(Boolean) as AnyEvent[];
        if (items.length === 0) return 0;
        items.sort((a, b) => b.id - a.id);
        return items[0].id;
    }
}

// Singleton bus for the process
export const gameEvents = new GameEventBus();

/**
 * Helper to build ActorRef from your game objects without importing them here.
 * Callers pass the concrete data.
 */
export function makeActorRef(kind: ActorKind, name: string, side: Side, position: Coords): ActorRef {
    return { kind, name, side, position };
}
