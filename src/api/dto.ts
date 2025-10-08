// DTOs + pure mappers; import ONLY types from game
import type { Side } from "../settings.js";
import type { Player } from "../player.js";
import type { Ship } from "../ship.js";
import type { Planet } from "../planet.js";
import type { Star } from "../star.js";
import type { Blackhole } from "../blackhole.js";

export type PositionDTO = Readonly<{ v: number; h: number }>;

export type PlayerDTO = Readonly<{
    name: string;
    side: Side;
    position: PositionDTO;
    condition: string;
    docked: boolean;
    shieldsUp: boolean;
    energy: number;
    damage: number;
    shieldEnergy: number;
    torpedoes: number;
    romulan?: Readonly<{ isRomulan: boolean; isRevealed: boolean; cloaked: boolean }>;
}>;

export type PlanetDTO = Readonly<{
    name?: string;
    side: Side;
    position: PositionDTO;
    isBase: boolean;
    builds: number;
    energy: number; // for bases: 0..1000 shields; for planets: whatever you store
}>;

export type BaseDTO = Readonly<{
    side: Side;
    position: PositionDTO;
    energy: number; // 0..1000
}>;

export type StarDTO = Readonly<{
    position: PositionDTO;
}>;

export type BlackholeDTO = Readonly<{
    position: PositionDTO;
}>;

export type SummaryDTO = Readonly<{
    timestamp: number;
    counts: Readonly<{
        players: number;
        ships: number;
        planets: number;
        stars: number;
        blackholes: number;
        federationShips: number;
        empireShips: number;
        federationBases: number;
        empireBases: number;
    }>;
}>;

// ---- Mappers (pure, lint-safe) ----

export function toPlayerDTO(p: Player & { ship: Ship }): Readonly<PlayerDTO> {
    const s = p.ship;
    return Object.freeze({
        name: s.name,
        side: s.side,
        position: Object.freeze({ v: s.position.v, h: s.position.h }),
        condition: s.condition,
        docked: s.docked,
        shieldsUp: s.shieldsUp,
        energy: s.energy,
        damage: s.damage,
        shieldEnergy: s.shieldEnergy,
        torpedoes: s.torpedoes,
        romulan: s.romulanStatus
            ? Object.freeze({
                isRomulan: !!s.romulanStatus.isRomulan,
                isRevealed: !!s.romulanStatus.isRevealed,
                cloaked: !!s.romulanStatus.cloaked,
            })
            : undefined,
    });
}

export function toPlanetDTO(pl: Planet): Readonly<PlanetDTO> {
    return Object.freeze({
        name: (pl as { name?: string }).name,
        side: pl.side,
        position: Object.freeze({ v: pl.position.v, h: pl.position.h }),
        isBase: !!pl.isBase,
        builds: pl.builds,
        energy: pl.energy,
    });
}

export function toBaseDTO(pl: Planet): Readonly<BaseDTO> {
    // Caller must ensure pl.isBase === true
    return Object.freeze({
        side: pl.side,
        position: Object.freeze({ v: pl.position.v, h: pl.position.h }),
        energy: pl.energy,
    });
}

export function toStarDTO(s: Star): Readonly<StarDTO> {
    return Object.freeze({
        position: Object.freeze({ v: s.position.v, h: s.position.h }),
    });
}

export function toBlackholeDTO(b: Blackhole): Readonly<BlackholeDTO> {
    return Object.freeze({
        position: Object.freeze({ v: b.position.v, h: b.position.h }),
    });
}

export function toSummaryDTO(args: {
    players: readonly Player[];
    planets: readonly Planet[];
    stars: readonly Star[];
    blackholes: readonly Blackhole[];
    federationBases: readonly Planet[];
    empireBases: readonly Planet[];
}): Readonly<SummaryDTO> {
    const { players, planets, stars, blackholes, federationBases, empireBases } = args;

    const ships = players.filter((p): p is Player & { ship: Ship } => Boolean(p.ship));
    const federationShips = ships.filter(p => p.ship.side === "FEDERATION").length;
    const empireShips = ships.filter(p => p.ship.side === "EMPIRE").length;

    return Object.freeze({
        timestamp: Date.now(),
        counts: Object.freeze({
            players: players.length,
            ships: ships.length,
            planets: planets.length,
            stars: stars.length,
            blackholes: blackholes.length,
            federationShips,
            empireShips,
            federationBases: federationBases.length,
            empireBases: empireBases.length,
        }),
    });
}
