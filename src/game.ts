import { Blackhole } from "./blackhole.js";
import { Planet } from "./planet.js";
import { Player } from "./player.js";
import { Star } from "./star.js";
import { setRandomSeed } from './util/random.js';
import { PointsManager } from "./points.js";
import { settings } from "./settings.js";
import { updateRomulan, maybeSpawnRomulan } from "./romulan.js";
import { sendAllPendingMessages, sendMessageToClient } from "./communication.js";
import net from "net";
import { chebyshev } from "./coords.js";
import { applyPhaserShipDamage } from "./phaser.js";

export const players: Player[] = [];
export const limbo: Player[] = [];
export let planets: Planet[] = [];
export const bases = {
    federation: [] as Planet[],
    empire: [] as Planet[],
};
export const stars: Star[] = [];
export const blackholes: Blackhole[] = [];
export const stardate: number = 0;
export const pointsManager: PointsManager = new PointsManager();

export function generateGalaxy(seed?: string): void {
    if (!seed) {
        seed = Date.now().toString();
    }
    setRandomSeed(seed);

    planets = Planet.generate();
    Planet.generateBases();
    Blackhole.generate();
    Star.generate();
    settings.generated = true;
}

function updateGameTick(): void {
    let ticked = nextTick();
    if (Math.random() < 0.5) {
        ticked = true;
    }
    if (ticked)
        console.log(settings.timeConsumingMoves, players.length, ticked);

    checkForDisconnectedPlayers();

    // for (const player of players) {
    //     //player.updateLifeSupport(); //TODO
    // }

    if (ticked) {
        updateRomulan();
        maybeSpawnRomulan();
        performPlanetAttacks();
        performBaseAttacks();

        //energyRegeneration();
        //repairAllPlayerDevices();
        //repairAllBases();
    }

    //checkForNova();
    checkForBlackholes();
    //checkForInactivity();
    checkVictoryConditions();
    setTimeout(updateGameTick, 1000);
}
updateGameTick();

function nextTick(): boolean {
    if (settings.timeConsumingMoves > players.length) {
        settings.timeConsumingMoves = 0;
        settings.stardate += 1;
        return true;
    }
    return false;
}


function checkForPendingMessages(): void {
    sendAllPendingMessages();
    setTimeout(checkForPendingMessages, 30);
}
checkForPendingMessages();

function checkForDisconnectedPlayers() {
    for (const player of players) {
        if (!isSocketLive(player.socket)) {
            removePlayerFromGame(player);
        }
    }
}

export function isSocketLive(socket: net.Socket): boolean {
    return (!socket.destroyed && socket.writable && socket.readable);
}

function checkVictoryConditions(): void {
    if (settings.winner != null || !settings.generated) return; // Already declared

    // const fedAlive = players.some(p => p.ship.side === "FEDERATION");
    // const empAlive = players.some(p => p.ship.side === "EMPIRE");

    const fedBasesExist = bases.federation.length > 0;
    const empBasesExist = bases.empire.length > 0;

    const fedPlanetsExist = planets.some(p => p.side === "FEDERATION");
    const empPlanetsExist = planets.some(p => p.side === "EMPIRE");

    const fedEliminated = !fedBasesExist && !fedPlanetsExist;
    const empEliminated = !empBasesExist && !empPlanetsExist;

    if (empEliminated) {
        settings.winner = "FEDERATION";
    } else if (fedEliminated) {
        settings.winner = "EMPIRE";
    }

    if (settings.winner) {
        const message = `\r\n*** The ${settings.winner} has won the war! ***\r\n`;
        for (const player of [...players, ...limbo]) {
            sendMessageToClient(player, message);
            //putPlayerInLimbo(player); //TODO
        }
        //restartGame(); //TODO
    }
}

export function performPlanetAttacks(): void {
    const numPlayers = players.length;
    for (const planet of planets) {
        if (planet.isBase) continue;
        if (Math.random() < 0.5) continue;
        const builds = planet.builds;


        for (const player of players) {
            if (!player.ship) continue;
            const range = chebyshev(planet.position, player.ship.position);
            if (range > 2) continue; // Planet attack range is 4 sectors


            // Skip if player is not alive or ship is cloaked
            if (player.ship.romulanStatus.cloaked) {
                continue;
            }

            // Skip if the planet is captured and the ship is on the same side
            if (planet.side !== "NEUTRAL" && player.ship.side === planet.side) {
                continue;
            }

            const hit = (50 + (30 * builds)) / numPlayers;
            if (Math.random() < getHitProbability(range)) {
                applyPhaserShipDamage(planet, player, hit);
            }

        }
    }
}

export function performBaseAttacks(): void {
    const allBases = [...bases.federation, ...bases.empire];

    for (const base of allBases) {
        const numPlayers = players.length;


        for (const player of players) {
            if (!player.ship) continue;
            const range = chebyshev(base.position, player.ship.position);
            if (range > 4) continue; // Planet attack range is 4 sectors


            // Skip if player is not alive or ship is cloaked
            if (player.ship.romulanStatus.cloaked) {
                continue;
            }

            // Skip if the planet is captured and the ship is on the same side
            if (player.ship.side === base.side) {
                continue;
            }

            const hit = 200 / numPlayers;
            if (Math.random() < getHitProbability(range)) {
                applyPhaserShipDamage(base, player, hit);
            }

        }
    }
}

export function checkForBlackholes(): void {
    for (const player of players) {
        const ship = player.ship;
        if (!ship) continue;
        const { v, h } = ship.position;

        // if that ship happens to be on a black‑hole sector…
        if (blackholes.some(bh => bh.position.v === v && bh.position.h === h)) {
            sendMessageToClient(player,
                "You have fallen into a black hole. Your ship is crushed and annihilated.");
            //putPlayerInLimbo(player, true); //TODO
        }
    }
}

export function removePlayerFromGame(player: Player): void {
    // Remove from global players list
    const idx = players.findIndex(p => p === player);
    if (idx !== -1) players.splice(idx, 1);
    // Remove ship from destroyedShips list if present
    // const shipIdx = destroyedShips.indexOf(player.ship.name ?? "");
    // if (shipIdx !== -1) destroyedShips.splice(shipIdx, 1);
    // Close their socket
    // playerCache.push(player);
    player.socket?.end();
    player.socket?.destroy();
}

function getHitProbability(distance: number): number {
    const maxProb = 0.65; // 65% at 0 sectors
    const minProb = 0.05; // 5% at max range (4 for bases, 2 for planets)
    const maxRange = 4; // or 2 for planets
    return minProb + (maxProb - minProb) * (1 - distance / maxRange);
}