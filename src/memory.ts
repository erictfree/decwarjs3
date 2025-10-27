import { Player } from "./player.js";
import { Planet } from "./planet.js";
import { Side } from "./settings.js";


export const teamMemory = {
    federation: new Map<string, Planet>(),
    empire: new Map<string, Planet>()
};

// export function addBaseToMemory(player: Player, base: Base): void {
//     const memory = player.ship.side === "FEDERATION" ? teamBaseMemory.federation : teamBaseMemory.empire;
//     memory.bases.set(`${base.y},${base.x}`, base);
// }

export function addPlanetToMemory(player: Player, planet: Planet): void {
    if (!player.ship) return;

    const memory = player.ship.side === "FEDERATION" ? teamMemory.federation : teamMemory.empire;
    memory.set(`${planet.position.v},${planet.position.h}`, planet);
}

// export function removeBaseFromMemory(base: Base): void {
//     teamMemory.federation.bases.delete(`${base.y},${base.x}`);
//     teamMemory.empire.bases.delete(`${base.y},${base.x}`);
// }

export function removePlanetFromMemory(planet: Planet): void {
    removePlanetFromAllMemories(planet.position.v, planet.position.h);
}

// export function isBaseInMemory(player: Player, base: Base): boolean {
//     const memory = player.ship.side === "FEDERATION" ? teamBaseMemory.federation : teamBaseMemory.empire;
//     return memory.bases.has(`${base.y},${base.x}`);
// }

export function isPlanetInMemory(player: Player, planet: Planet): boolean {
    if (!player.ship) return false;
    const memory = player.ship.side === "FEDERATION" ? teamMemory.federation : teamMemory.empire;
    return memory.has(`${planet.position.v},${planet.position.h}`);
}

const key = (v: number, h: number) => `${v},${h}`;

export function removePlanetFromTeamMemory(side: Side, v: number, h: number) {
    const m = side === "FEDERATION" ? teamMemory.federation : teamMemory.empire;
    m.delete(key(v, h));
}

export function removePlanetFromAllMemories(v: number, h: number) {
    const k = key(v, h);
    teamMemory.federation.delete(k);
    teamMemory.empire.delete(k);
}