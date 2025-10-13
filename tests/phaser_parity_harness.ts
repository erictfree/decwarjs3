/*
 * Phaser parity harness — 10× lighter damage with legacy ×10 energy debit
 *
 * What this does
 *  - Reimplements the PHADAM math deterministically (base falloff = 0.91)
 *  - Runs a grid of scenarios and prints CSV to stdout
 *  - Compares two debit policies: legacy_x10 and scaled_x1
 *
 * How to run
 *  - npx ts-node phaser_parity_harness.ts
 *  - or: tsc phaser_parity_harness.ts && node phaser_parity_harness.js
 */

// ==== knobs ================================================================
const PHADAM_PHIT_DIVISOR = 10; // 10× lighter visible damage
const RANDOM_FALLOFF = 0.91;    // deterministic stand‑in for 0.90..0.92

// ==== core types ===========================================================
type ShotInput = {
  distance: number;             // chebyshev distance (1..10)
  shieldsPct: number;           // 0..1000 (Fortran scale)
  shieldsUp: boolean;           // ship shields toggle
  isBase: boolean;              // bases treated as shielded
  phitInput: number;            // user-entered energy (50..500)
  damagedPhaser?: boolean;      // optional
  damagedComputer?: boolean;    // optional
};

type ShotOutput = {
  powfac: number;
  phitIn: number;               // after divisor (damage-side only)
  shieldsAfter: number;         // 0..1000
  through: number;              // penetration fraction before powfac/phit
  hull: number;                 // final hull damage (already 10× lighter)
  shieldDrain: number;          // amount drained from shieldsPct
  critEstimate: boolean;        // rough legacy-threshold check
};

// ==== PHADAM-like snapshot =================================================
function phaserShot(inp: ShotInput): ShotOutput {
  const damaged = !!(inp.damagedPhaser || inp.damagedComputer);

  // distance falloff
  let hit = Math.pow(RANDOM_FALLOFF, Math.max(0, inp.distance));
  if (damaged) hit *= 0.8;

  // powfac: halves if target is base or has shields up (and >0)
  let powfac = 80;
  if (inp.isBase || (inp.shieldsUp && inp.shieldsPct > 0)) powfac = 40;

  // scaled phit for damage-side math only
  const phitIn = Math.max(0, Math.floor(inp.phitInput / PHADAM_PHIT_DIVISOR));

  // shield logic
  const shieldsBefore = inp.shieldsPct;
  let shieldsPct = inp.shieldsPct;
  let through = 0;
  let shieldDrain = 0;
  let hull = 0;

  const treatedAsShielded = inp.isBase || (inp.shieldsUp && shieldsPct > 0);
  if (treatedAsShielded) {
    // penetration uses pre-drain percent
    through = hit * (1000 - shieldsPct) * 0.001;

    // drain uses raw hit, powfac, phitIn and (pct with 0.1 floor), then *0.03
    const pctFactor = Math.max(shieldsPct * 0.001, 0.1);
    shieldDrain = (hit * powfac * phitIn * pctFactor + 10) * 0.03;

    shieldsPct = Math.max(0, shieldsPct - shieldDrain);

    // hull gets only the uncovered portion
    hull = through * powfac * phitIn;
  } else {
    // shields down: full hit goes to hull
    hull = hit * powfac * phitIn;
  }

  // numeric clamp when effectively 100%
  if (shieldsBefore >= 999.999 && treatedAsShielded) {
    through = 0; hull = 0;
  }

  // legacy crit threshold (note: will rarely trigger at 10× lighter scale)
  const critEstimate = hull >= 1700;

  return {
    powfac,
    phitIn,
    shieldsAfter: shieldsPct,
    through,
    hull,
    shieldDrain,
    critEstimate,
  };
}

// ==== grid runner ==========================================================
const distances = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const shieldLevels = [1000, 500, 0];
const userInputs = [50, 200, 500];

const cases: Array<{ label: string; flags: Pick<ShotInput, 'isBase' | 'shieldsUp'> }> = [
  { label: 'Ship: shields UP', flags: { isBase: false, shieldsUp: true } },
  { label: 'Ship: shields DOWN', flags: { isBase: false, shieldsUp: false } },
  { label: 'Base', flags: { isBase: true, shieldsUp: true } },
];

function runGrid(): string {
  // CSV header
  const rows: string[] = [
    [
      'scenario', 'user_input', 'distance', 'powfac', 'phit_in_for_damage',
      'shields_up?', 'shields_pct_before', 'shields_pct_after', 'shield_drain',
      'through', 'hull_damage', 'crit_estimate', 'energy_debit_legacy_x10', 'energy_debit_scaled_x1'
    ].join(',')
  ];

  for (const c of cases) {
    for (const E of userInputs) {
      for (const dist of distances) {
        for (const s of shieldLevels) {
          const out = phaserShot({
            distance: dist,
            shieldsPct: s,
            shieldsUp: c.flags.shieldsUp,
            isBase: c.flags.isBase,
            phitInput: E,
          });

          const legacyDebit = E * 10; // FORTRAN behavior
          const scaledDebit = E * 1;  // alternative policy

          rows.push([
            c.label,
            E.toString(),
            dist.toString(),
            out.powfac.toFixed(1),
            out.phitIn.toFixed(0),
            String(c.flags.shieldsUp),
            s.toFixed(0),
            out.shieldsAfter.toFixed(3),
            (s - out.shieldsAfter).toFixed(3),
            out.through.toFixed(6),
            out.hull.toFixed(3),
            String(out.critEstimate),
            legacyDebit.toFixed(0),
            scaledDebit.toFixed(0),
          ].join(','));
        }
      }
    }
  }

  return rows.join('\n');
}

if (require.main === module) {
  const csv = runGrid();
  // Print as CSV so it can be redirected to a file
  // Example: node phaser_parity_harness.js > phaser_parity_grid.csv
  console.log(csv);
}
