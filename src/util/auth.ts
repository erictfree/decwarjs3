//import { playerCache } from '../game.js';
import { Player } from '../player.js';
// Auth session interface for player authentication

export interface AuthSession {
    ip: string;
    email?: string;
    code?: string;
    authed: boolean;
    createdAt: number;
}

export function generateAccessCode(): string {
    const part1 = Math.floor(1000 + Math.random() * 9000); // e.g., 4-digit
    const part2 = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${part1}-${part2}`;
}

export function isValidEmail(email: string): boolean {
    const trimmed = email.trim().toLowerCase();
    const emailRegex =
        /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
    return emailRegex.test(trimmed);
}

export function emailHasSameIp(email: string, ip: string): Player | null {
    return null; // TODO PUT BACK TODO
    // const matchingPlayer = playerCache.find(p =>
    //     p.auth.ip === ip &&
    //     p.auth.email?.toLowerCase() === email.toLowerCase()
    // );

    // if (matchingPlayer) {
    //     const idx = playerCache.indexOf(matchingPlayer);
    //     playerCache.splice(idx, 1);
    //     return matchingPlayer;
    // }
    // return null;
}


// Export an empty object to ensure the file is treated as a module
export { };