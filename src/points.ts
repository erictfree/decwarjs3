import { Command } from "./command.js";
import { sendMessageToClient } from "./communication.js";
import { matchesPattern } from "./util/util.js";
import { Player } from './player.js';
import { Side, settings } from './settings.js';
import { pointsManager } from './game.js';

// PointsManager is assumed to be in a separate file (game.js), but included here for completeness
export type PointCategory =
  | 'damageToEnemies'
  | 'enemiesDestroyed'
  | 'damageToBases'
  | 'planetsCaptured'
  | 'basesBuilt'
  | 'damageToRomulans'
  | 'starsDestroyed'
  | 'planetsDestroyed';

type Points = Record<PointCategory, number>;

export class PointsManager {
  // === Primary totals (points) ===
  private teamTotals: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private turnTotals: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private playerTotals: Map<Player, number> = new Map();

  // === Lightweight counters for UI/compat ===
  private shipsCommissioned: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private enemiesDestroyed: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private planetsCaptured: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private planetsDestroyed: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private starsDestroyed: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;

  // SIDE-OWNED sources (bases, captured planets, auto-defenses)
  creditInstallationDamage(ownerSide: Side, amount: number) {
    if (ownerSide === "NEUTRAL" || amount <= 0) return;
    this.teamTotals[ownerSide] = (this.teamTotals[ownerSide] ?? 0) + amount;
    this.turnTotals[ownerSide] = (this.turnTotals[ownerSide] ?? 0) + amount;
  }
  creditInstallationKill(ownerSide: Side, bonus: number) {
    if (ownerSide === "NEUTRAL" || bonus <= 0) return;
    this.teamTotals[ownerSide] = (this.teamTotals[ownerSide] ?? 0) + bonus;
    this.turnTotals[ownerSide] = (this.turnTotals[ownerSide] ?? 0) + bonus;
  }

  // SHIP-OWNED sources (we know the attacker)
  creditShipDamage(attacker: Player, amount: number) {
    const side = attacker.ship?.side as Side | undefined;
    if (!side || side === "NEUTRAL" || amount <= 0) return;
    this.playerTotals.set(attacker, (this.playerTotals.get(attacker) ?? 0) + amount);
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) + amount;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) + amount;
  }
  creditShipKill(attacker: Player, victimSide: Side, bonus: number) {
    const side = attacker.ship?.side as Side | undefined;
    if (!side || side === "NEUTRAL" || bonus <= 0) return;
    this.playerTotals.set(attacker, (this.playerTotals.get(attacker) ?? 0) + bonus);
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) + bonus;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) + bonus;
    // compat counter
    this.enemiesDestroyed[side] = (this.enemiesDestroyed[side] ?? 0) + 1;
  }

  /** @deprecated use creditInstallationDamage/creditShipDamage instead. */
  addDamageToEnemies(amount: number, by: Player | undefined, side: Side) {
    if (by) return this.creditShipDamage(by, amount);
    return this.creditInstallationDamage(side, amount);
  }

  // (optional) getters for POINTS UI
  getTeamTotals() { return { ...this.teamTotals }; }
  getTurnTotals() { return { ...this.turnTotals }; }
  getPlayerTotal(p: Player) { return this.playerTotals.get(p) ?? 0; }

  // === Back-compat shims ===
  // Keep behavior minimal & predictable; callers can migrate gradually to explicit APIs.

  // Used by: capture flow UI; records count only (no points by itself here).
  addPlanetsCaptured(count: number, _by: Player | undefined, side: Side) {
    if (!side || side === "NEUTRAL" || count === 0) return;
    this.planetsCaptured[side] = (this.planetsCaptured[side] ?? 0) + count;
  }

  // Used by: nova/kill paths; increments kill COUNTER only (points should be credited where the kill is decided).
  addEnemiesDestroyed(count: number, by: Player | undefined, side: Side) {
    if (by) {
      // prefer explicit path for points; this shim only keeps a counter for UI
      this.enemiesDestroyed[by.ship!.side as Side] = (this.enemiesDestroyed[by.ship!.side as Side] ?? 0) + count;
    } else if (side && side !== "NEUTRAL") {
      this.enemiesDestroyed[side] = (this.enemiesDestroyed[side] ?? 0) + count;
    }
  }

  // Legacy "damage to bases" meter; treat as generic damage credit.
  addDamageToBases(amount: number, by: Player | undefined, side: Side) {
    if (by) return this.creditShipDamage(by, amount);
    return this.creditInstallationDamage(side, amount);
  }

  // Nova star collapse counter; no points here (adjust if you want stars to grant points).
  addStarsDestroyed(count: number, _by: Player | undefined, side: Side) {
    if (!side || side === "NEUTRAL" || count === 0) return;
    this.starsDestroyed[side] = (this.starsDestroyed[side] ?? 0) + count;
  }

  addPlanetsDestroyed(count: number, _by: Player | undefined, side: Side) {
    if (!side || side === "NEUTRAL" || count === 0) return;
    this.planetsDestroyed[side] = (this.planetsDestroyed[side] ?? 0) + count;
  }

  // UI helpers used by points panel
  // Return a Points-shaped object (typed as any to match existing UI type without changing its definition).
  getPointsForSide(side: Side): any {
    return {
      // common fields most score UIs expect; adjust names if your Points type differs
      total: this.teamTotals[side] ?? 0,
      turnTotal: this.turnTotals[side] ?? 0,
      enemiesDestroyed: this.enemiesDestroyed[side] ?? 0,
      planetsCaptured: this.planetsCaptured[side] ?? 0,
      planetsDestroyed: this.planetsDestroyed[side] ?? 0,
      starsDestroyed: this.starsDestroyed[side] ?? 0,
      shipsCommissioned: this.shipsCommissioned[side] ?? 0,
    };
  }
  getShipsCommissioned(side: Side): number {
    return this.shipsCommissioned[side] ?? 0;
  }
  incrementShipsCommissioned(side: Side) {
    if (!side || side === "NEUTRAL") return;
    this.shipsCommissioned[side] = (this.shipsCommissioned[side] ?? 0) + 1;
  }
}


// Types for points command
interface Score {
  label: string;
  points: Points;
  ships: number;
  side?: Side; // Tracks side for team scores
}

export function pointsCommand(player: Player, command: Command): void {
  if (!player.ship) {
    sendMessageToClient(player, "You must be in a ship to use this command.");
    return;
  }

  const keywords: string[] = [];
  const filters = ["Me", "I", "Federation", "Human", "Empire", "Klingon", "Romulan", "All"];

  for (const arg of command.args) {
    let matched = false;
    for (const pattern of filters) {
      if (matchesPattern(arg, pattern)) {
        keywords.push(pattern.toUpperCase());
        matched = true;
        break;
      }
    }
    if (!matched) {
      sendMessageToClient(player, `Invalid filter: ${arg}`);
      return;
    }
  }

  const scores: Score[] = [];

  // Default to individual score if no keywords
  if (keywords.length === 0 || keywords.includes("ALL") || keywords.includes("ME") || keywords.includes("I")) {
    scores.push({
      label: player.ship.name,
      points: player.points,
      ships: 1,
      side: player.ship.side
    });
  }

  // Federation score
  if (keywords.includes("ALL") || keywords.includes("FEDERATION") || keywords.includes("HUMAN")) {
    scores.push({
      label: "FEDERATION",
      points: pointsManager.getPointsForSide("FEDERATION"),
      ships: pointsManager.getShipsCommissioned("FEDERATION"),
      side: "FEDERATION"
    });
  }

  // Empire score
  if (keywords.includes("ALL") || keywords.includes("EMPIRE") || keywords.includes("KLINGON")) {
    scores.push({
      label: "EMPIRE",
      points: pointsManager.getPointsForSide("EMPIRE"),
      ships: pointsManager.getShipsCommissioned("EMPIRE"),
      side: "EMPIRE"
    });
  }

  // Romulan score
  if (keywords.includes("ALL") || keywords.includes("ROMULAN")) {
    scores.push({
      label: "ROMULAN",
      points: pointsManager.getPointsForSide("ROMULAN"),
      ships: pointsManager.getShipsCommissioned("ROMULAN"),
      side: "ROMULAN"
    });
  }

  const output = formatScores(scores, player);
  sendMessageToClient(player, output);
}

function formatScores(scores: Score[], player: Player): string {
  if (scores.length < 1 || scores.length > 4) {
    return "";
  }

  // Scaling factors per DECWAR help text
  const pointScales: Record<PointCategory, number> = {
    damageToEnemies: 1,
    enemiesDestroyed: 500,
    damageToBases: 1,
    planetsCaptured: 100,
    basesBuilt: 1000,
    damageToRomulans: 1,
    starsDestroyed: -50,
    planetsDestroyed: -100
  };

  // Point-related headers
  const pointHeaders: { label: string; key: keyof Points }[] = [
    { label: "Damage to enemies", key: "damageToEnemies" },
    { label: "Enemies destroyed", key: "enemiesDestroyed" },
    { label: "Damage to bases", key: "damageToBases" },
    { label: "Planets captured", key: "planetsCaptured" },
    { label: "Bases built", key: "basesBuilt" },
    { label: "Damage to Romulans", key: "damageToRomulans" },
    { label: "Stars destroyed", key: "starsDestroyed" },
    { label: "Planets destroyed", key: "planetsDestroyed" }
  ];

  // Filter headers with non-zero values
  const activeHeaders = pointHeaders.filter(header =>
    scores.some(score => score.points[header.key] !== 0)
  );

  // Fixed headers
  const fixedHeaders = ["", "Total points:", "", "Number of ships:", "Pts. / player:", "Pts. / stardate:"];
  const headers = [...activeHeaders.map(h => h.label), ...fixedHeaders];
  const maxLabelLength = Math.max(...scores.map(s => s.label.length), ...headers.map(h => h.length));
  const colWidth = 15;
  const formatNum = (n: number): string => n.toFixed(0).padStart(6); // DECWAR uses integers

  // Build header row
  let result = " ".repeat(maxLabelLength);
  for (const score of scores) {
    result += score.label.padStart(colWidth);
  }
  result += "\r\n";

  // Build data rows
  for (const header of headers) {
    if (header === "") {
      result += "\r\n";
      continue;
    }
    result += header.padEnd(maxLabelLength);
    for (const score of scores) {
      let value: string;
      switch (header) {
        case "Total points:": {
          const total = activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0);
          value = formatNum(total);
          break;
        }
        case "Number of ships:": {
          value = formatNum(score.ships);
          break;
        }
        case "Pts. / player:": {
          const total = activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0);
          const ships = score.ships;
          value = formatNum(ships > 0 ? Math.floor(total / ships) : 0); // Integer division
          break;
        }
        case "Pts. / stardate:": {
          const total = activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0);
          let turns: number;
          if (score.side && score.side === player.ship?.side && score.ships === 1) {
            // Individual player
            turns = player.stardate;
          } else if (score.side) {
            // Team
            const sideKey = score.side.toLowerCase() as keyof typeof settings.teamTurns;
            turns = settings.teamTurns[sideKey] || 0;
          } else {
            turns = 0;
          }
          value = formatNum(turns > 0 ? Math.floor(total / turns) : 0); // Integer division
          break;
        }
        default: {
          const pointHeader = activeHeaders.find(h => h.label === header);
          value = pointHeader ? formatNum(score.points[pointHeader.key] * pointScales[pointHeader.key]) : "0".padStart(6);
          break;
        }
      }
      result += value.padStart(colWidth);
    }
    result += "\r\n";
  }

  return `\r\n${result}\r\n`;
}