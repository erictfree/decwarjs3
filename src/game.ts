import { Blackhole } from "./blackhole.js";
import { Planet } from "./planet.js";
import { Player } from "./player.js";
import { Star } from "./star.js";
import { setRandomSeed } from './util/random.js';
import { PointsManager } from "./points.js";
import { settings, INACTIVITY_TIMEOUT } from "./settings.js";
import { updateRomulan, maybeSpawnRomulan } from "./romulan.js";
import { sendAllPendingMessages, sendMessageToClient } from "./communication.js";
import net from "net";
import { chebyshev } from "./coords.js";
import { pointsCommand } from "./points.js";
import { basphaFireOnce } from "./starbase_phasers.js";
import { planetPhaserDefense } from "./phaser.js";
import { baseEnergyRegeneration } from "./planet.js";
export const SHIP_FATAL_DAMAGE = 25000;  // adjusted for fortran derived code
import { romulanApproachTick } from "./romulan.js";

// bot imports
import { updateBots, botChatterTick } from "./bots/bot.js";
import { spawnAndRegisterBot } from "./bots/register.js";




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

export const PLANET_PHASER_RANGE = 2; // Fortran pdist <= 2


// mark existing player objects as bots
// spawnAndRegisterBot("aggressor", "FEDERATION", "BOT-KIRK");
// spawnAndRegisterBot("defender", "EMPIRE", "BOT-KOL");





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


    // bot testing, TODO remove later

    //  if (process.env.SPAWN_BOTS === "1") {
    // spawnAndRegisterBot("aggressor", "FEDERATION", "BOT-KIRK");
    // spawnAndRegisterBot("defender", "EMPIRE", "BOT-KOL");
    //  }
}

// export function processTimeConsumingMove(player: Player) {
//     if (!player.ship) return;
//     if (player.ship.side == "FEDERATION") {
//         settings.teamTurns.federation += 1;
//     } else if (player.ship.side == "EMPIRE") {
//         settings.teamTurns.empire += 1;
//     } else if (player.ship.side == "ROMULAN") {
//         settings.teamTurns.romulan += 1;
//     }

//     player.stardate += 1;
//     settings.dotime += 1;
//     const numply = players.length;

//     // Perform periodic actions if dotime >= numply (mirrors if (dotime .lt. numply) goto 3501)
//     if (settings.dotime >= numply) {
//         settings.dotime = 0; // Reset dotime (mirrors dotime = 0)

//         // Periodic actions (mirrors basbld, baspha, plnatk, romdrv)
//         baseEnergyRegeneration(player); // Mirrors BASBLD
//         performPlanetOrBaseAttacks(true); // Mirrors BASPHA (enemy bases)
//         performPlanetOrBaseAttacks(false); // Mirrors PLNATK (neutral/enemy planets)
//         updateRomulan(); // Mirrors romdrv (partially)
//         if (settings.romulans) {
//             maybeSpawnRomulan(); // Mirrors romdrv (Romulan spawning)
//         }
//     }

//     for (const player of players) {
//         player.updateLifeSupport();
//     }
// }

export function processTimeConsumingMove(player: Player) {
    if (!player.ship) return;

    // Team turn bookkeeping
    if (player.ship.side === "FEDERATION") {
        settings.teamTurns.federation += 1;
    } else if (player.ship.side === "EMPIRE") {
        settings.teamTurns.empire += 1;
    } else if (player.ship.side === "ROMULAN") {
        settings.teamTurns.romulan += 1;
    }

    player.stardate += 1;
    settings.dotime += 1;

    // ACTIVE players only (alive ships), never 0; 25,000 fatal threshold
    const numply = Math.max(
        1,
        players.filter(p => p?.ship && p.ship.energy > 0 && p.ship.damage < SHIP_FATAL_DAMAGE).length
    );

    // Once per full sweep of players
    if (settings.dotime >= numply) {
        settings.dotime = 0; // reset sweep

        // Periodic parity actions
        baseEnergyRegeneration(player);     // BASBLD
        basphaFireOnce(player, numply);     // BASPHA (enemy bases fire once)
        planetPhaserDefense(player);        // PLNATK (planet auto-phasers)

        // Romulan driver (spawn + behavior), gated
        if (settings.romulans) {
            updateRomulan();                  // ROMDRV weapon logic (fires if cooldowns ready)
            romulanApproachTick();            // Optional: take safe steps toward target between volleys
            maybeSpawnRomulan();              // ROMDRV spawn cadence
        }
    }

    // call every time-consuming move “sweep”
    updateBots();
    botChatterTick(); // optional flavor

    // Life support upkeep for everyone
    for (const p of players) p.updateLifeSupport();
}


function updateGame(): void {
    checkForDisconnectedPlayers();
    checkForInactivity();
    releaseStalePlanetCaptureLocks()
    if (settings.blackholes) {
        checkForBlackholes();
    }


    //testing remove todo
    updateBots();
    botChatterTick(); // optional flavor

    setTimeout(updateGame, 1000);
}
updateGame();

function releaseStalePlanetCaptureLocks() {
    const now = Date.now();
    for (const planet of planets) {
        if (planet.captureLock.status === true &&
            (now - planet.captureLock.time > 10000)
        ) {
            planet.captureLock.status = false;
        }
    }
}



function checkForPendingMessages(): void {
    sendAllPendingMessages();
    setTimeout(checkForPendingMessages, 30);
}
setTimeout(checkForPendingMessages, 1000);


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


// function planetOrBasePhaserDamage(distance: number, target: Player): number {
//     let baseHit = Math.pow(0.9 + 0.02 * Math.random(), distance); // Fortran: pwr(0.9–0.92, id)
//     if (target.ship && (target.ship.devices.phaser > 0 || target.ship.devices.computer > 0)) {
//         baseHit *= 0.8; // Fortran: hit *= 0.8 if damaged
//     }
//     return baseHit;
// }

export function performPlanetOrBaseAttacks(base: boolean = false): void {
    for (const planet of planets) {
        if (planet.isBase !== base) continue; // Bases if base=true, planets if base=false
        if (planet.side === "NEUTRAL") {
            if (!base && Math.random() < 0.5) continue;
        }

        for (const player of players) {
            if (!player.ship) continue;
            if (player.ship.side === planet.side) continue;
            if (player.ship.romulanStatus.cloaked) continue;

            const range = chebyshev(planet.position, player.ship.position);
            const maxRange = base ? 4 : 2; // 4 sectors for bases, 2 for planets
            if (range > maxRange) continue;
            //const phit = base ? 200 : 100; // 200 energy for bases, 100 for planets


            // DO_DAMANGE
            // calcShipFromPlanetPhaserDamage(phit, planet, player);
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

