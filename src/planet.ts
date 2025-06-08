import { GRID_WIDTH, GRID_HEIGHT, NUMBER_OF_PLANETS, Side, DEFAULT_BASE_ENERGY } from './settings.js';
import { chebyshev, ocdefCoords, Position } from './coords.js';
import { planets, bases } from './game.js';
import { getRandom } from './util/random.js';
import { getNearbyAlliedShips } from './ship.js';
import { addPendingMessage } from './communication.js';

export class Planet {
    public position: Position;
    public side: Side;
    public builds: number;
    public isBase: boolean;
    public strength: number;   // base
    public name: string;
    public hasCriedForHelp: boolean;
    //public captureProgress: { by: Side, progress: number, player: Player } | undefined;   // NOT CLEAR CHECK USAGE

    constructor(v: number, h: number) {
        this.position = { v: v, h: h };
        this.side = "NEUTRAL";
        this.builds = 0;
        this.isBase = false;
        this.strength = 0;
        this.name = "unnamed planet";
        this.hasCriedForHelp = false;
        //this.captureProgress = undefined;   // NOT CLEAR CHECK USAGE
    }

    makeBase(side: Side): void {
        const baseArray = side === "FEDERATION" ? bases.federation : bases.empire;
        this.isBase = true;
        this.side = side;
        this.strength = DEFAULT_BASE_ENERGY;
        baseArray.push(this);
    }

    removeBase(): void {   // total removal or just demoting?  TODO
        if (this.isBase) {
            const baseArray = this.side === "FEDERATION" ? bases.federation : bases.empire;
            this.isBase = false;
            this.side = "NEUTRAL";
            this.strength = 0;
            baseArray.splice(baseArray.indexOf(this), 1);
        }
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
            let v: number, h: number, conflict: boolean;
            let tries = 0;

            do {
                v = Math.floor(getRandom() * GRID_HEIGHT + 1);    // REPLACE FOR SEED
                h = Math.floor(getRandom() * GRID_WIDTH + 1); // REPLACE FOR SEED
                conflict = planets.some(p => chebyshev(p.position, { v: v, h: h }) < 2);
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

