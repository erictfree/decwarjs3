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
import { pointsCommand } from "./points.js";

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
        seed = settings.galaxySeed;
    }
    setRandomSeed(seed);

    planets = Planet.generate();
    Planet.generateBases();
    if (settings.blackholes) {
        Blackhole.generate();
    }
    Star.generate();
    settings.generated = true;
}

function updateGameTick(): void {
    console.log(settings.galaxySeed);
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
        if (settings.empire) {
            maybeSpawnRomulan();
        }
        performPlanetOrBaseAttacks(false);
        performPlanetOrBaseAttacks(true);
        //energyRegeneration();
        //repairAllPlayerDevices();
        //repairAllBases();
    }

    //checkForNova();
    if (settings.blackholes) {
        checkForBlackholes();
    }
    //checkForInactivity();
    checkEndGame();  // just went planet/bases destroyed? TODO
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

export function performPlanetOrBaseAttacks(base: boolean = false): void {
    const numPlayers = players.length;
    for (const planet of planets) {
        if (planet.isBase) continue;
        if (Math.random() < 0.5) continue;
        const builds = planet.builds;

        for (const player of players) {
            if (!player.ship) continue;
            if (player.ship.side === planet.side) continue;
            if (player.ship.romulanStatus.cloaked) continue;

            const range = chebyshev(planet.position, player.ship.position);
            if (base && planet.isBase) {
                if (range > 4) continue; // Planet attack range is 4 sectors
            } else {
                if (range > 2) continue; // Planet attack range is 4 sectors
            }

            let hit = (50 + (30 * builds)) / numPlayers;
            if (base && planet.isBase) {
                hit = 200 / numPlayers;
            }
            if (Math.random() < getHitProbability(range)) {
                applyPhaserShipDamage(planet, player, hit);
            }

        }
    }
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

function checkEndGame(): void {
    // From 1978 docs:
    // This routine is called whenever a base or planet is destroyed
    // to see if the game is over. (all the planets gone, and one
    // side's bases).  If so, the appropriate message is printed out
    // and the job is returned to monitor level.

    if (settings.winner != null || !settings.generated) return;

    const fedPlanetsExist = planets.some(p => p.side === "FEDERATION" && !p.isBase);
    const empPlanetsExist = planets.some(p => p.side === "EMPIRE" && !p.isBase);

    if (fedPlanetsExist || empPlanetsExist) {
        return;
    }

    const fedBasesExist = bases.federation.length > 0;
    const empBasesExist = bases.empire.length > 0;

    if (!empBasesExist && fedBasesExist) {
        settings.winner = "FEDERATION";
    } else if (!fedBasesExist && empBasesExist) {
        settings.winner = "EMPIRE";
    } else if (!empBasesExist && !fedBasesExist) {
        settings.winner = "NEUTRAL";
    } else {
        return;
    }
    console.log(settings.winner);

    let message = ``;
    if (settings.winner) {
        message += `\r\nThe game has ended.\r\n`;
        if (settings.winner === "NEUTRAL") {
            message += `All planets and bases have been destroyed. No victor emerges.\r\n`;
        } else {
            if (settings.winner === "FEDERATION") {
                message += `All Empire starbases have been eliminated.\r\n`;
                message += `The Empire has been defeated. The Federation is victorious!\r\n`;
            } else {
                message += `All Federation starbases have been eliminated.\r\n`;
                message += `The Federation has been defeated. The Empire is victorious!\r\n`;
            }
        }

        for (let i = players.length - 1; i >= 0; i--) {
            const player = players[i];
            removePlayerFromGame(player);
            if (!player.ship) continue;

            sendMessageToClient(player, message);
            pointsCommand(player, { key: 'POINTS', args: ['all'], raw: 'points all' });
            sendMessageToClient(player, "", true, true);

        }
        settings.generated = false;
        settings.winner = null;
        settings.gameNumber += 1;
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
    // player.socket?.end();
    // player.socket?.destroy();
}

function getHitProbability(distance: number): number {
    const maxProb = 0.65; // 65% at 0 sectors
    const minProb = 0.05; // 5% at max range (4 for bases, 2 for planets)
    const maxRange = 4; // or 2 for planets
    return minProb + (maxProb - minProb) * (1 - distance / maxRange);
}