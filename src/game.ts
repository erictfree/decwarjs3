import { Blackhole } from "./blackhole.js";
import { Planet } from "./planet.js";
import { Player } from "./player.js";
import { Star } from "./star.js";
import { setRandomSeed } from './util/random.js';
import { PointsManager } from "./points.js";
import { settings, INACTIVITY_TIMEOUT, INITIAL_BASE_STRENGTH } from "./settings.js";
import { updateRomulan, maybeSpawnRomulan } from "./romulan.js";
import { sendAllPendingMessages, sendMessageToClient, addPendingMessage } from "./communication.js";
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
        seed = settings.tournamentSeed;
    }
    setRandomSeed(seed);

    //     nstar = int(51 * ran(0)) * 5 + 100
    //     nhole = int(41.0 * ran(0) + 10)
    //    c-- nplnet = int(20.0 + ran(0) * 61.0)
    //     nplnet = 60 ! ALWAYS insert max. # of planets

    const nstar = Math.floor(51 * Math.random()) * 5 + 100;
    const nhole = Math.floor(41 * Math.random() + 10);
    const nplnet = 60;

    planets = Planet.generate(nplnet);
    Planet.generateBases();  // 10 each
    Star.generate(nstar);
    if (settings.blackholes) {
        Blackhole.generate(nhole);
    }
    console.log(nstar, nhole, nplnet);
    settings.generated = true;
}

export function processTimeConsumingMove(player: Player) {
    if (!player.ship) return;
    if (player.ship.side == "FEDERATION") {
        settings.teamTurns.federation += 1;
    } else if (player.ship.side == "EMPIRE") {
        settings.teamTurns.empire += 1;
    } else if (player.ship.side == "ROMULAN") {
        settings.teamTurns.romulan += 1;
    }

    player.stardate += 1;
    settings.dotime += 1;
    const numply = players.length;

    // Perform periodic actions if dotime >= numply (mirrors if (dotime .lt. numply) goto 3501)
    if (settings.dotime >= numply) {
        settings.dotime = 0; // Reset dotime (mirrors dotime = 0)

        // Periodic actions (mirrors basbld, baspha, plnatk, romdrv)
        baseEnergyRegeneration(player); // Mirrors BASBLD
        performPlanetOrBaseAttacks(true); // Mirrors BASPHA (enemy bases)
        performPlanetOrBaseAttacks(false); // Mirrors PLNATK (neutral/enemy planets)
        updateRomulan(); // Mirrors romdrv (partially)
        if (settings.romulans) {
            maybeSpawnRomulan(); // Mirrors romdrv (Romulan spawning)
        }
    }

    for (const player of players) {
        player.updateLifeSupport();
    }
}

function updateGame(): void {
    checkForDisconnectedPlayers();
    checkForInactivity();
    if (settings.blackholes) {
        checkForBlackholes();
    }

    setTimeout(updateGame, 1000);
}
updateGame();


function checkForPendingMessages(): void {
    sendAllPendingMessages();
    setTimeout(checkForPendingMessages, 30);
}
checkForPendingMessages();


function checkForInactivity() {
    for (const player of players) {
        if (!player.ship) continue;

        const inactiveTime = Date.now() - player.lastActivity;

        if (inactiveTime >= INACTIVITY_TIMEOUT) {
            sendMessageToClient(player, "Captain, you have been inactive for too long. You have been removed from the game.");
            removePlayerFromGame(player);

        }
    }
}

function baseEnergyRegeneration(player: Player): void {
    // if player is romulan get both bases, otherwise get enemy bases
    let n = 0;
    let basestoUpdate: Planet[] = [];
    if (player.ship && player.ship.side === "ROMULAN") {
        basestoUpdate = [...bases.federation, ...bases.empire];
        n = Math.floor(50 / (players.length + 1));
    } else if (player.ship) {
        const side = player.ship.side;
        basestoUpdate = (player.ship.side === "FEDERATION" ? bases.empire : bases.federation);
        // Count number of players on the same side as the player
        const numSidePlayers = players.filter(p => p.ship && p.ship.side === side).length;
        n = Math.floor(25 / (numSidePlayers || 1));
    }
    for (const base of basestoUpdate) {
        base.energy = Math.min(base.energy + n, INITIAL_BASE_STRENGTH);
    }
}

function planetOrBasePhaserDamage(distance: number, target: Player): number {
    let baseHit = Math.pow(0.9 + 0.02 * Math.random(), distance); // Fortran: pwr(0.9–0.92, id)
    if (target.ship && (target.ship.devices.phaser > 0 || target.ship.devices.computer > 0)) {
        baseHit *= 0.8; // Fortran: hit *= 0.8 if damaged
    }
    return baseHit;
}

export function performPlanetOrBaseAttacks(base: boolean = false): void {
    for (const planet of planets) {
        if (planet.isBase !== base) continue; // Bases if base=true, planets if base=false

        for (const player of players) {
            if (!player.ship) continue;
            if (player.ship.side === planet.side) continue;
            if (player.ship.romulanStatus.cloaked) continue;

            const range = chebyshev(planet.position, player.ship.position);
            const maxRange = base ? 4 : 2; // 4 sectors for bases, 2 for planets
            if (range > maxRange) continue;

            const hit = planetOrBasePhaserDamage(range, player);
            const powfac = player.ship.shieldsUp ? 40 : 80; // Fortran: powfac halved if shields up
            const phit = base ? 0.4 : 0.2; // 200 energy for bases, 100 for planets

            if (hit > 0) {
                addPendingMessage(player, `\r\n** ALERT ** ${base ? 'Starbase' : 'Planet'} at ${planet.position.v}-${planet.position.h} opens fire!`);
                addPendingMessage(player, `You are under automatic phaser attack from ${base ? 'enemy starbase' : 'planet'}!`);
                applyPhaserShipDamage(planet, player, hit, powfac, phit); // Fixed TS2554
            }
        }
    }
}

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

export function checkEndGame(): void {
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
        message += `\r\nTHE WAR IS OVER!!!\r\n`;
        if (settings.winner === "NEUTRAL") {
            message += `The entire known galaxy has been depopulated.\r\n`;
        } else {
            if (settings.winner === "FEDERATION") {
                message += `The Federation has successfully repelled the Klingon hordes!!\r\n`;
            } else {
                message += `The Klingon Empire is VICTORIOUS!!!\r\n`;
            }
        }

        for (let i = players.length - 1; i >= 0; i--) {
            const player = players[i];
            removePlayerFromGame(player);
            if (!player.ship) continue;

            if (settings.winner === "FEDERATION" && player.ship.side === "FEDERATION") {
                message += `Congratulations. Freedom again reigns the galaxy.\r\n`;
            } else if (settings.winner === "EMPIRE" && player.ship.side === "EMPIRE") {
                message += `The Empire salutes you. Begin slave operations immediately.\r\n`;
            } else if (settings.winner === "FEDERATION" && player.ship.side === "EMPIRE") {
                message += `The Empire has fallen. Initiate self-destruction procedure.\r\n`;
            } else if (settings.winner === "EMPIRE" && player.ship.side === "FEDERATION") {
                message += `Please proceed to the nearest Klingon slave planet."\r\n`;
            }

            sendMessageToClient(player, message);
            pointsCommand(player, { key: 'POINTS', args: ['all'], raw: 'points all' });
            sendMessageToClient(player, "", true, true);

        }
        settings.generated = false;
        settings.winner = null;
        settings.gameNumber += 1;
    }
}

/*

endgm0	"THE WAR IS OVER!!!"	Generic endgame banner
endgm1	"The entire known galaxy has been depopulated."	Everyone destroyed (stalemate)
endgm3	"The Klingon Empire is VICTORIOUS!!!"	Empire wins
endgm4	"The Federation has successfully repelled the Klingon hordes!!"	Federation wins
endgm5	"Please proceed to the nearest Klingon slave planet."	Federation defeat (player message)
endgm6	"Congratulations. Freedom again reigns the galaxy."	Federation win (player message)
endgm7	"The Empire salutes you. Begin slave operations immediately."	Empire win (player message)
endgm8	"The Empire has fallen. Initiate self-destruction procedure."

    */

export function checkForBlackholes(): void {
    for (const player of players) {
        const ship = player.ship;
        if (!ship) continue;
        const { v, h } = ship.position;

        // if that ship happens to be on a black‑hole sector…
        if (blackholes.some(bh => bh.position.v === v && bh.position.h === h)) {
            sendMessageToClient(player,
                "\r\nYou have fallen into a black hole. Your ship is crushed and annihilated.");
            removePlayerFromGame(player);
            sendMessageToClient(player, "", true, true);
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

// function getHitProbability(distance: number): number {
//     const maxProb = 0.65; // 65% at 0 sectors
//     const minProb = 0.05; // 5% at max range (4 for bases, 2 for planets)
//     const maxRange = 4; // or 2 for planets
//     return minProb + (maxProb - minProb) * (1 - distance / maxRange);
// }

