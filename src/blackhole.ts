import { findObjectAtPosition, Position } from './coords.js';
import { GRID_HEIGHT, GRID_WIDTH } from './settings.js';
import { blackholes } from './game.js';
import { getRandom } from './util/random.js';


export class Blackhole {
    position: Position;

    constructor(v: number, h: number) {
        this.position = { v, h };
    }

    static generate(count: number = 10): Blackhole[] {
        let attempts = 0;

        while (blackholes.length < count && attempts < 1000) {
            const v = Math.floor(getRandom() * GRID_HEIGHT) + 1;
            const h = Math.floor(getRandom() * GRID_WIDTH) + 1;

            if (!findObjectAtPosition(v, h)) {
                blackholes.push(new Blackhole(v, h));
            }

            attempts++;
        }
        return blackholes;
    }
}


