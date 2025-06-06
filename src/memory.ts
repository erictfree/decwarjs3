import { Player } from "./player";
import { Planet } from "./planet";


export const teamMemory = {
    federation: { planets: new Map<string, Planet>() },
    empire: { planets: new Map<string, Planet>() }
};

// export function addBaseToMemory(player: Player, base: Base): void {
//     const memory = player.ship.side === "FEDERATION" ? teamBaseMemory.federation : teamBaseMemory.empire;
//     memory.bases.set(`${base.y},${base.x}`, base);
// }

export function addPlanetToMemory(player: Player, planet: Planet): void {
    if (!player.ship) return;

    const memory = player.ship.side === "FEDERATION" ? teamMemory.federation : teamMemory.empire;
    memory.planets.set(`${planet.position.v},${planet.position.h}`, planet);
}

// export function removeBaseFromMemory(base: Base): void {
//     teamMemory.federation.bases.delete(`${base.y},${base.x}`);
//     teamMemory.empire.bases.delete(`${base.y},${base.x}`);
// }

export function removePlanetFromMemory(planet: Planet): void {
    teamMemory.federation.planets.delete(`${planet.position.v},${planet.position.h}`);
    teamMemory.empire.planets.delete(`${planet.position.v},${planet.position.h}`);
}

// export function isBaseInMemory(player: Player, base: Base): boolean {
//     const memory = player.ship.side === "FEDERATION" ? teamBaseMemory.federation : teamBaseMemory.empire;
//     return memory.bases.has(`${base.y},${base.x}`);
// }

export function isPlanetInMemory(player: Player, planet: Planet): boolean {
    if (!player.ship) return false;
    const memory = player.ship.side === "FEDERATION" ? teamMemory.federation : teamMemory.empire;
    return memory.planets.has(`${planet.position.v},${planet.position.h}`);
}