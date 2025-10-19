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
  // === DECWAR buckets that the POINTS UI expects ===
  private damageToEnemies: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private damageToBases: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private basesBuilt: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  private damageToRomulans: Record<Side, number> = { FEDERATION: 0, EMPIRE: 0, ROMULAN: 0, NEUTRAL: 0 } as any;
  // === Per-category human-unit tallies for the POINTS UI (FORTRAN categories) ===
  private categoryTotals: Record<Side, Record<PointCategory, number>> = {
    FEDERATION: { damageToEnemies: 0, enemiesDestroyed: 0, damageToBases: 0, planetsCaptured: 0, basesBuilt: 0, damageToRomulans: 0, starsDestroyed: 0, planetsDestroyed: 0 },
    EMPIRE: { damageToEnemies: 0, enemiesDestroyed: 0, damageToBases: 0, planetsCaptured: 0, basesBuilt: 0, damageToRomulans: 0, starsDestroyed: 0, planetsDestroyed: 0 },
    ROMULAN: { damageToEnemies: 0, enemiesDestroyed: 0, damageToBases: 0, planetsCaptured: 0, basesBuilt: 0, damageToRomulans: 0, starsDestroyed: 0, planetsDestroyed: 0 },
    NEUTRAL: { damageToEnemies: 0, enemiesDestroyed: 0, damageToBases: 0, planetsCaptured: 0, basesBuilt: 0, damageToRomulans: 0, starsDestroyed: 0, planetsDestroyed: 0 },
  };

  // SIDE-OWNED sources (bases, captured planets, auto-defenses)
  creditInstallationDamage(ownerSide: Side, amount: number) {
    if (ownerSide === "NEUTRAL" || amount <= 0) return;
    this.teamTotals[ownerSide] = (this.teamTotals[ownerSide] ?? 0) + amount;
    this.turnTotals[ownerSide] = (this.turnTotals[ownerSide] ?? 0) + amount;
    // Installation fire counts as "damage to enemies" in FORTRAN
    this.categoryTotals[ownerSide].damageToEnemies += amount;
  }
  creditInstallationKill(ownerSide: Side, _bonus: number) {
    if (ownerSide === "NEUTRAL") return;
    // FORTRAN: +500 per enemy destroyed (installation-originated)
    const award = 500;
    this.teamTotals[ownerSide] = (this.teamTotals[ownerSide] ?? 0) + award;
    this.turnTotals[ownerSide] = (this.turnTotals[ownerSide] ?? 0) + award;
    this.enemiesDestroyed[ownerSide] = (this.enemiesDestroyed[ownerSide] ?? 0) + 1;
    this.categoryTotals[ownerSide].enemiesDestroyed += 1;
  }

  // SHIP-OWNED sources (we know the attacker)
  creditShipDamage(attacker: Player, amount: number) {
    const side = attacker.ship?.side as Side | undefined;
    if (!side || side === "NEUTRAL" || amount <= 0) return;
    this.playerTotals.set(attacker, (this.playerTotals.get(attacker) ?? 0) + amount);
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) + amount;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) + amount;
    this.categoryTotals[side].damageToEnemies += amount;
  }

  /**
   * Ship → BASE damage (FORTRAN "Damage to bases" bucket; 1:1 human units).
   * Use when a player's attack damages an enemy *base* (not a ship).
   */
  creditBaseDamageByShip(attacker: Player, amount: number) {
    const side = attacker.ship?.side as Side | undefined;
    if (!side || side === "NEUTRAL" || amount <= 0) return;
    this.playerTotals.set(attacker, (this.playerTotals.get(attacker) ?? 0) + amount);
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) + amount;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) + amount;
    this.categoryTotals[side].damageToBases += amount;
  }
  creditShipKill(attacker: Player, _victimSide: Side, _bonus: number) {
    const side = attacker.ship?.side as Side | undefined;
    if (!side || side === "NEUTRAL") return;
    // FORTRAN: +500 per enemy ship destroyed
    this.playerTotals.set(attacker, (this.playerTotals.get(attacker) ?? 0) + 500);
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) + 500;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) + 500;
    this.enemiesDestroyed[side] = (this.enemiesDestroyed[side] ?? 0) + 1;
    this.categoryTotals[side].enemiesDestroyed += 1;
  }

  /** @deprecated use creditInstallationDamage/creditShipDamage instead. */
  addDamageToEnemies(amount: number, by: Player | undefined, side: Side) {
    if (by) return this.creditShipDamage(by, amount);
    return this.creditInstallationDamage(side, amount);
  }

  // Damage specifically to enemy bases is tracked in its own bucket (FORTRAN).
  addDamageToBases(amount: number, by: Player | undefined, side: Side) {
    if (amount <= 0) return;
    if (by) {
      this.creditBaseDamageByShip(by, amount);
      return;
    }
    if (!side || side === "NEUTRAL") return;
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) + amount;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) + amount;
    this.categoryTotals[side].damageToBases += amount;
  }

  /**
   * Romulan damage (FORTRAN: "Damage to Romulans" — scale 1).
   * Must credit team/turn (and player when attributed) exactly like normal damage.
   */
  addDamageToRomulans(amount: number, by: Player | undefined, side: Side) {
    if (amount <= 0) return;
    const s: Side | undefined = by?.ship?.side ?? side;
    if (!s || s === "NEUTRAL") return;
    // bucket (for POINTS columns)
    this.damageToRomulans[s] = (this.damageToRomulans[s] ?? 0) + amount;
    // per-player attribution (if a ship dealt the damage)
    if (by) {
      this.playerTotals.set(by, (this.playerTotals.get(by) ?? 0) + amount);
    }
    // team and turn totals (scale 1 like other damage)
    this.teamTotals[s] = (this.teamTotals[s] ?? 0) + amount;
    this.turnTotals[s] = (this.turnTotals[s] ?? 0) + amount;
  }

  // FORTRAN: Bases built (1000 points each) — award immediately and track category
  addBasesBuilt(count: number, side: Side) {
    if (count <= 0 || side === "NEUTRAL") return;
    this.basesBuilt[side] = (this.basesBuilt[side] ?? 0) + count;
    const award = 1000 * count;
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) + award;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) + award;
    this.categoryTotals[side].basesBuilt += count;
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
    this.categoryTotals[side].planetsCaptured += count;
    // FORTRAN: +100 per successful capture
    const award = 100 * count;
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) + award;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) + award;
  }

  // Used by: nova/kill paths; increments kill COUNTER only (points should be credited where the kill is decided).
  addEnemiesDestroyed(count: number, by: Player | undefined, side: Side) {
    if (by) {
      // prefer explicit path for points; this shim only keeps a counter for UI
      this.enemiesDestroyed[by.ship!.side as Side] = (this.enemiesDestroyed[by.ship!.side as Side] ?? 0) + count;
      this.categoryTotals[by.ship!.side as Side].enemiesDestroyed += count;
    } else if (side && side !== "NEUTRAL") {
      this.enemiesDestroyed[side] = (this.enemiesDestroyed[side] ?? 0) + count;
      this.categoryTotals[side].enemiesDestroyed += count;
    }
  }


  // Nova star collapse counter; no points here (adjust if you want stars to grant points).
  addStarsDestroyed(count: number, _by: Player | undefined, side: Side) {
    if (!side || side === "NEUTRAL" || count === 0) return;
    this.starsDestroyed[side] = (this.starsDestroyed[side] ?? 0) + count;
    this.categoryTotals[side].starsDestroyed += count;
    // FORTRAN: -50 per star destroyed
    const penalty = 50 * count;
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) - penalty;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) - penalty;
  }

  addPlanetsDestroyed(count: number, _by: Player | undefined, side: Side) {
    if (!side || side === "NEUTRAL" || count === 0) return;
    this.planetsDestroyed[side] = (this.planetsDestroyed[side] ?? 0) + count;
    this.categoryTotals[side].planetsDestroyed += count;
    // FORTRAN: -100 per planet destroyed
    const penalty = 100 * count;
    this.teamTotals[side] = (this.teamTotals[side] ?? 0) - penalty;
    this.turnTotals[side] = (this.turnTotals[side] ?? 0) - penalty;
  }


  addRomulansDestroyed(count: number, by: Player | undefined, side: Side) {
    if (count === 0) return;
    const s = by ? (by.ship?.side as Side | undefined) : side;
    if (!s || s === "NEUTRAL") return;
    // Counter for UI (if you show it) and +500 each to totals
    this.categoryTotals[s].enemiesDestroyed += 0; // keep enemy-ship counter separate
    const award = 500 * count;
    this.teamTotals[s] = (this.teamTotals[s] ?? 0) + award;
    this.turnTotals[s] = (this.turnTotals[s] ?? 0) + award;
  }

  // UI helpers used by points panel
  // Return the eight raw DECWAR buckets from categoryTotals (single source of truth).
  getPointsForSide(side: Side): any {
    const c = this.categoryTotals[side];
    return {
      damageToEnemies: c.damageToEnemies,
      enemiesDestroyed: c.enemiesDestroyed,
      damageToBases: c.damageToBases,
      planetsCaptured: c.planetsCaptured,
      basesBuilt: c.basesBuilt,
      damageToRomulans: c.damageToRomulans,
      starsDestroyed: c.starsDestroyed,
      planetsDestroyed: c.planetsDestroyed,
      // extras shown by your UI but not part of FORTRAN point math
      total: this.teamTotals[side] ?? 0,
      turnTotal: this.turnTotals[side] ?? 0,
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