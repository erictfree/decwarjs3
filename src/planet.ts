import { GRID_WIDTH, GRID_HEIGHT, NUMBER_OF_PLANETS, Side, DEFAULT_BASE_ENERGY } from './settings.js';
import { findObjectAtPosition, ocdefCoords, Position } from './coords.js';
import { planets, bases } from './game.js';
import { getRandom } from './util/random.js';
import { getNearbyAlliedShips } from './ship.js';
import { addPendingMessage } from './communication.js';
import { Player } from './player.js';
import { players } from './game.js';
import { emitBaseBuilt } from "./api/events.js";

interface CaptureLock {
    status: boolean;
    time: number;
}

export class Planet {
    public position: Position;
    public side: Side;
    public builds: number;
    public isBase: boolean;
    public energy: number;   // base
    public name: string;
    public hasCriedForHelp: boolean;
    public captureLock: CaptureLock;
    //public captureProgress: { by: Side, progress: number, player: Player } | undefined;   // NOT CLEAR CHECK USAGE

    constructor(v: number, h: number) {
        this.position = { v: v, h: h };
        this.side = "NEUTRAL";
        this.builds = 0;
        this.isBase = false;
        this.energy = 0;
        this.name = "unknown";
        this.hasCriedForHelp = false;
        this.captureLock = { status: false, time: 0 };
        //this.captureProgress = undefined;   // NOT CLEAR CHECK USAGE
    }

    makeBase(side: Side): void {
        const baseArray = side === "FEDERATION" ? bases.federation : bases.empire;
        this.isBase = true;
        this.side = side;
        this.energy = DEFAULT_BASE_ENERGY;
        baseArray.push(this);
    }

    callForHelp(v: number, h: number, side: Side): void {
        const allies = getNearbyAlliedShips(v, h, side, 10);

        for (const player of allies) {
            if (!player.ship) continue;
            const coords = ocdefCoords(player.settings.ocdef, player.ship.position, { v: v, h: h });
            const message = `Starbase at ${coords} under attack! Assist immediately.`;
            addPendingMessage(player, message);
        }
    }

    static getBases(side: Side | "ALL"): Planet[] {
        if (side === "ALL") {
            return [...bases.federation, ...bases.empire];
        }
        return side === "FEDERATION" ? bases.federation : bases.empire;
    }

    static generate(count: number = NUMBER_OF_PLANETS): Planet[] {
        const planets: Planet[] = [];
        for (let i = 0; i < count; i++) {
            let v: number, h: number;
            let conflict: boolean;
            let tries = 0;

            do {
                v = Math.floor(getRandom() * GRID_HEIGHT + 1);    // REPLACE FOR SEED
                h = Math.floor(getRandom() * GRID_WIDTH + 1); // REPLACE FOR SEED
                conflict = findObjectAtPosition(v, h) !== null;
                tries++;
            } while (conflict && tries < 500);

            if (conflict) {
                console.warn(`Could not safely place planet ${i + 1} after ${tries} attempts.`);
                continue;
            }

            const planet = new Planet(v, h);
            planet.name = `PL${i + 1}`;
            planet.side = "NEUTRAL";
            planets.push(planet);
        }

        return planets;
    }

    static generateBases(): void {
        const promotePlanetsToBases = (side: Side, planets: Planet[], max: number = 10) => {
            function shuffle(array: Planet[]) {
                for (let i = array.length - 1; i > 0; i--) {
                    const j = Math.floor(getRandom() * (i + 1));
                    [array[i], array[j]] = [array[j], array[i]]; // Swap elements
                }
                return array;
            }
            // Filter owned planets not already bases
            const eligiblePlanets = planets.filter(p => !p.isBase);

            // Randomize selection
            const shuffled = shuffle(eligiblePlanets);

            let bases = 0;
            for (const planet of shuffled) {
                if (bases >= max) break;
                planet.makeBase(side);
                bases++;
            }
        };

        promotePlanetsToBases("FEDERATION", planets);
        promotePlanetsToBases("EMPIRE", planets);
    }
}



// Exact BASBLD parity
export function baseEnergyRegeneration(triggeringPlayer: Player) {
    // Helpers
    const alivePlayers = players.filter(p => p?.ship && p.ship.energy > 0);
    const numply = alivePlayers.length; // active players only
    const countActiveForSide = (side: Side) =>
        Math.max(1, alivePlayers.filter(p => p.ship!.side === side).length); // avoid /0

    const isRomulan = !!triggeringPlayer.ship?.romulanStatus?.isRomulan;

    // Integer 'n' exactly like Fortran:
    // Romulan: n = 50 / (numply + 1)
    // Player : n = 25 / numsid(team)
    let n: number;
    if (isRomulan) {
        n = Math.floor(50 / (numply + 1)); // integer division
    } else {
        const moverSide = triggeringPlayer.ship!.side as Side;
        const team: Side = moverSide; // FEDERATION | EMPIRE | ROMULAN (ROMULAN shouldn't happen here, but it's typed)

        // numsid(team) — active ships on mover's team
        const numsidRaw = countActiveForSide(team); // declare/import as (side: Side) => number
        const numsid = Math.max(1, numsidRaw);      // avoid divide-by-zero

        n = Math.floor(25 / numsid);
    }

    // Which bases to regenerate:
    // - Romulan: both sides
    // - Player : opposite side only
    const sidesToRegen: ("FEDERATION" | "EMPIRE")[] = isRomulan
        ? ["FEDERATION", "EMPIRE"]
        : triggeringPlayer.ship!.side === "FEDERATION" ? ["EMPIRE"] : ["FEDERATION"];

    // Do the regeneration, capping at 1000 (Fortran min0(..., 1000))
    for (const side of sidesToRegen) {
        const list = side === "FEDERATION" ? bases.federation : bases.empire;
        for (const base of list) {
            if (base.energy > 0) {
                base.energy = Math.min(base.energy + n, 1000);
            }
        }
    }
}

