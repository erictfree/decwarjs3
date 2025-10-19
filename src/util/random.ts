import seedrandom from 'seedrandom';
import type { PRNG } from 'seedrandom';
import { settings } from '../settings.js';
let rng: PRNG | null = null;

export function setRandomSeed(str: string): void {
    settings.tournamentSeed = str;
    rng = seedrandom(settings.tournamentSeed);
}

export function getRandom(): number {
    // Core random in [0,1).
    // If a seed is set, use the seeded PRNG; otherwise fall back to Math.random()
    // so unseeded games still behave like classic DECWAR (non-deterministic).
    return rng ? rng() : Math.random();
}

/**
 * Convenience: ran() -> float in [0,1)
 * Mirrors DECWAR's RAN(0) semantics.
 */
export function ran(): number {
    return getRandom();
}

/**
 * Convenience: iran(n) -> integer in [0, n-1]
 * Mirrors DECWAR's IRAN. If n <= 1, returns 0.
 */
export function iran(n: number): number {
    if (n <= 1) return 0;
    // Using getRandom() preserves determinism when seeded.
    return Math.floor(getRandom() * n);
}

/**
 * Optional helpers (handy in tests/tools)
 */
export function isSeeded(): boolean {
    return !!rng;
}

export function clearRandomSeed(): void {
    settings.tournamentSeed = '';
    rng = null;
}