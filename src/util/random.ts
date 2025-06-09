import seedrandom from 'seedrandom';
import type { PRNG } from 'seedrandom';
import { settings } from '../settings.js';
//const seedrandom = require('seedrandom')
//import seedrandom from 'seedrandom';

//var seedrandom = require('seedrandom');
let rng: PRNG | null = null;

export function setRandomSeed(str: string): void {
    settings.galaxySeed = str;
    rng = seedrandom(settings.galaxySeed);
}

export function getRandom(): number {
    if (rng) {
        return rng();
    } else {
        return 0;
    }
}