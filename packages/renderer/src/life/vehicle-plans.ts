/**
 * Close-up plans (life/vehicles.ts `VehicleSpec.fine`): the same crafts about twice as finely, for
 * zooms where the coarse plan runs out of resolution. Seen from above, front to the right, one
 * string per row across the craft, its left side first. Letters are parts, as in a coarse plan,
 * plus `W`, dark rubber: `B` body, `R` roof, `G` glass, `H` headlight, `T` taillight, `D` and `L`
 * trim, `A` accent, `.` empty. A craft with several entries varies between individuals
 * (`vehicleLookPlan`); its first is the plain one, and repeating one makes it commoner.
 */
// prettier-ignore
const SEDAN = [
  // Trunk, rear window, roof, windshield, hood, a mirror each side.
  '.TBBWWWBBBBBBBBBDWWWBBB.',
  'TBBGGGGGGGGGGGGGGGGGBBBH',
  'BBBGGRRRRRRRRRRRGGGGBBBB',
  'BBBGGRRRRRRRRRRRGGGGBBBB',
  'BBBGGRRRRRRRRRRRGGGGBBBB',
  'BBBGGRRRRRRRRRRRGGGGBBBB',
  'TBBGGGGGGGGGGGGGGGGGBBBH',
  '.TBBWWWBBBBBBBBBDWWWBBB.',
] as const;
// prettier-ignore
const SOLO_RIDER = [
  // Wheels fore and aft, the rider's shoulders and helmet, handlebars ahead of them.
  '.....DD..D..',
  'TWWBBDRRBBWH',
  '.....DD..D..',
] as const;

// prettier-ignore
export const FINE_PLANS = {
  car: [
    // A sedan, the commonest.
    SEDAN,
    SEDAN,
    // A hatchback: the roof runs almost to the tail.
    [
      '.TBWWWBBBBBBBBBBDWWWBBB.',
      'TBGGGGGGGGGGGGGGGGGGBBBH',
      'BGGRRRRRRRRRRRRRGGGGBBBB',
      'BGGRRRRRRRRRRRRRGGGGBBBB',
      'BGGRRRRRRRRRRRRRGGGGBBBB',
      'BGGRRRRRRRRRRRRRGGGGBBBB',
      'TBGGGGGGGGGGGGGGGGGGBBBH',
      '.TBWWWBBBBBBBBBBDWWWBBB.',
    ],
    // A pickup: an open bed with its load floor behind the cab.
    [
      '.TBBWWWBBBBBBBBBDWWWBBB.',
      'TBBBBBBBBBBGGGGGGGGGBBBH',
      'BBDDDDDDDBBGRRRRGGGGBBBB',
      'BBDLLDLLDBBGRRRRGGGGBBBB',
      'BBDLLDLLDBBGRRRRGGGGBBBB',
      'BBDDDDDDDBBGRRRRGGGGBBBB',
      'TBBBBBBBBBBGGGGGGGGGBBBH',
      '.TBBWWWBBBBBBBBBDWWWBBB.',
    ],
    // A van: a long roof and hardly any hood.
    [
      '.TBBWWWBBBBBBBBBBDWWWBB.',
      'TBGGGGGGGGGGGGGGGGGGGBBH',
      'BBRRRRRRRRRRRRRRRRRGGGBB',
      'BBRRRRRRRRRRRRRRRRRGGGBB',
      'BBRRRRRRRRRRRRRRRRRGGGBB',
      'BBRRRRRRRRRRRRRRRRRGGGBB',
      'TBGGGGGGGGGGGGGGGGGGGBBH',
      '.TBBWWWBBBBBBBBBBDWWWBB.',
    ],
  ],
  motorcycle: [
    // A rider alone, the commonest.
    SOLO_RIDER,
    SOLO_RIDER,
    // With someone riding behind.
    [
      '..DD.DD..D..',
      'TWDRRDRRBBWH',
      '..DD.DD..D..',
    ],
  ],
  tricycle: [
    // The motorcycle on the left with its rider; the roofed sidecar with its seat on the right.
    [
      'TWWBBDDRRBBWWH',
      'TWWBBDDRRBBWWH',
      '.......D..D...',
      'RRRRRRRRRRRGG.',
      'RDDDDRRRRRRGG.',
      'RDDDDRRRRRRGG.',
    ],
  ],
  jeepney: [
    // Stripes down both sides, the open door at the back, a long hood with its grille.
    [
      'TAWWWAAAAAAAAAAAAAWWWAGBBBBH',
      'BAAAAAAAAAAAAAAAAAAAAAGBBBBB',
      'DRRRRRRRRRRRRRRRRRRRRRGBBLLB',
      'DRRRRRRRRRRRRRRRRRRRRRGBBLLB',
      'BAAAAAAAAAAAAAAAAAAAAAGBBBBB',
      'TAWWWAAAAAAAAAAAAAWWWAGBBBBH',
    ],
    // With a luggage rack on the roof.
    [
      'TAWWWAAAAAAAAAAAAAWWWAGBBBBH',
      'BAAAAAAAAAAAAAAAAAAAAAGBBBBB',
      'DRDDDDDDDDDDDDDDDDRRRRGBBLLB',
      'DRDLDLDLDLDLDLDLDDRRRRGBBLLB',
      'BAAAAAAAAAAAAAAAAAAAAAGBBBBB',
      'TAWWWAAAAAAAAAAAAAWWWAGBBBBH',
    ],
  ],
  bus: [
    // Air conditioners and a roof hatch; a wide windshield ahead of a short nose.
    [
      'TBWWWBBBBBBBBBBBBBBBBBBBBWWWBBBBGGBH',
      'BGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGBB',
      'BRRRDDDDRRRRRRRRLLRRRRRRRDDDDRRRGGBB',
      'BRRRDDDDRRRRRRRRLLRRRRRRRDDDDRRRGGBB',
      'BGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGBB',
      'TBWWWBBBBBBBBBBBBBBBBBBBBWWWBBBBGGBH',
    ],
  ],
  truck: [
    // A bed of crates behind the cab.
    [
      'TDWWWDDDDDDDDDDDDDDDBWWWBBBBGGBH',
      'DLLLLLLLDLLLLLLLDLLLBBBBBBBBGGBB',
      'DLLLLLLLDLLLLLLLDLLLBBRRRRRRGGBB',
      'DRRRRRRRDRRRRRRRDRRRBBRRRRRRGGBB',
      'DLLLLLLLDLLLLLLLDLLLBBBBBBBBGGBB',
      'TDWWWDDDDDDDDDDDDDDDBWWWBBBBGGBH',
    ],
    // A tarpaulin in a second color over its load.
    [
      'TDWWWDDDDDDDDDDDDDDDBWWWBBBBGGBH',
      'DAAAAAAAAAAAAAAAAAAABBBBBBBBGGBB',
      'DAADAAADAAADAAADAAAABBRRRRRRGGBB',
      'DAADAAADAAADAAADAAAABBRRRRRRGGBB',
      'DAAAAAAAAAAAAAAAAAAABBBBBBBBGGBB',
      'TDWWWDDDDDDDDDDDDDDDBWWWBBBBGGBH',
    ],
    // An empty open bed, slatted.
    [
      'TDWWWDDDDDDDDDDDDDDDBWWWBBBBGGBH',
      'DBBBBBBBBBBBBBBBBBBDBBBBBBBBGGBB',
      'DLDLDLDLDLDLDLDLDLLDBBRRRRRRGGBB',
      'DLDLDLDLDLDLDLDLDLLDBBRRRRRRGGBB',
      'DBBBBBBBBBBBBBBBBBBDBBBBBBBBGGBB',
      'TDWWWDDDDDDDDDDDDDDDBWWWBBBBGGBH',
    ],
  ],
  bicycle: [
    // Two thin wheels, the rider's shoulders and head, handlebars.
    [
      '......DD..D...',
      'TWWWBDRRDBWWWH',
      '......DD..D...',
    ],
  ],
  rowboat: [
    // Pointed at both ends, three thwarts, the rower and their oars.
    [
      '....BBBBBBBBBBBB....',
      '..BBDBBBDDBBBDBBBB..',
      'BBBBDBBBRRBBBDBBBBBB',
      '..BBDBBBDDBBBDBBBB..',
      '....BBBBBBBBBBBB....',
    ],
  ],
  motorboat: [
    // A canopy on ribs, a windscreen, an outboard at the stern, a light at the bow.
    [
      '..BBBBBBBBBBBBBB..',
      'BBBBRRDRRDRRGBBBBB',
      'DBBBRRDRRDRRGBBBBH',
      'DBBBRRDRRDRRGBBBBH',
      'BBBBRRDRRDRRGBBBBB',
      '..BBBBBBBBBBBBBB..',
    ],
  ],
  banca: [
    // Bamboo outriggers on two booms; a slender hull under a ribbed canopy.
    [
      '....LLLLLLLLLLLLLLLL....',
      '......B........B........',
      '......B........B........',
      '...BBBBBRRDRRDRRBBBBB...',
      'BAAABBBBRRDRRDRRBBBBAAAH',
      '...BBBBBRRDRRDRRBBBBB...',
      '......B........B........',
      '......B........B........',
      '....LLLLLLLLLLLLLLLL....',
    ],
  ],
  locomotive: [
    // Roof vents along a long hood, the cab's windows, lamps and couplings at both ends.
    [
      'TDBBBBBBBBBBBBBBBBBBBBBBGGGGBBBH',
      'DDBBBBBBBBBBBBBBBBBBBBBBGGGGBBBB',
      'DDRRLLRRLLRRLLRRLLRRLLRRRRGGBBBB',
      'LDRDRRDDRRDDRRDDRRDDRRDDRRGGBBBL',
      'LDRDRRDDRRDDRRDDRRDDRRDDRRGGBBBL',
      'DDRRLLRRLLRRLLRRLLRRLLRRRRGGBBBB',
      'DDBBBBBBBBBBBBBBBBBBBBBBGGGGBBBB',
      'TDBBBBBBBBBBBBBBBBBBBBBBGGGGBBBH',
    ],
  ],
  coach: [
    // A row of windows down each side, roof vents, couplings at both ends.
    [
      'BBBGGGBGGGBGGGBGGGBGGGBGGGBGGGBGGBBB',
      'BBBGGGBGGGBGGGBGGGBGGGBGGGBGGGBGGBBB',
      'DRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRD',
      'LRRRDDRRRRRRRDDRRRRRRRRDDRRRRRRDDRRL',
      'LRRRDDRRRRRRRDDRRRRRRRRDDRRRRRRDDRRL',
      'DRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRD',
      'BBBGGGBGGGBGGGBGGGBGGGBGGGBGGGBGGBBB',
      'BBBGGGBGGGBGGGBGGGBGGGBGGGBGGGBGGBBB',
    ],
  ],
  pagoda: [
    // Tiers of decorated canopy around the shrine, ringed with lights.
    [
      '....AAHAAHAAHAAHAAHA....',
      '..AARRRRRRRRRRRRRRRRAA..',
      '.ARRRRRRRRRRRRRRRRRRRRA.',
      'AARRLLLLLLLLLLLLLLLLRRAA',
      'HRRLBBBBHHHHHHHHBBBBLRRH',
      'ARRLBBHHAAAAAAAAHHBBLRRA',
      'ARRLBHAARRRRRRRRAAHBLRRA',
      'HRRLBHAARRDDDDRRAAHBLRRH',
      'ARRLBHAARRRRRRRRAAHBLRRA',
      'ARRLBBHHAAAAAAAAHHBBLRRA',
      'HRRLBBBBHHHHHHHHBBBBLRRH',
      'AARRLLLLLLLLLLLLLLLLRRAA',
      '.ARRRRRRRRRRRRRRRRRRRRA.',
      '..AARRRRRRRRRRRRRRRRAA..',
    ],
  ],
  voyador: [
    // Paddlers in pairs along a long narrow hull, a lamp at the bow.
    [
      '..BDBBDBBDBBDBBDBBDBBDBBDBB...',
      'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRH',
      'RRRDRRDRRDRRDRRDRRDRRDRRDRRRRH',
      '..BDBBDBBDBBDBBDBBDBBDBBDBB...',
    ],
  ],
  baroto: [
    // A dugout, pointed at both ends, with one paddler amidships.
    [
      '...BBBBBBBBBB...',
      'RBBBBBBDDBBBBBBR',
      '...BBBBBBBBBB...',
    ],
  ],
  sailboat: [
    // A hull and its mast, the sail bellying out to one side.
    [
      '......AAAAAA....',
      '...BAAAAAAAAB...',
      '.BBBBBBDDBBBBBB.',
      'BBBBBBBDDBBBBBBH',
      '.BBBBBBBBBBBBBB.',
      '...BBBBBBBBBB...',
    ],
  ],
  cart: [
    // An awning in stripes, with handles behind and a lantern at the front.
    [
      'DDWAARRAARRAWD',
      'DDARRAARRAARRD',
      'DDARRAARRAARRH',
      'DDARRAARRAARRH',
      'DDARRAARRAARRD',
      'DDWAARRAARRAWD',
    ],
  ],
  carabao: [
    // A broad back, a thick neck, wide swept-back horns and a switching tail.
    [
      '............DDD.',
      '..............D.',
      '..BBBBBBBBBB....',
      '.BBBBBRRBBBBBB..',
      'DBBBBBRRBBBBBBBB',
      '.BBBBBRRBBBBBB..',
      '..BBBBBBBBBB....',
      '..............D.',
      '............DDD.',
    ],
  ],
  ambulance: [
    // A box body with a light bar across its cab, red and white down the sides.
    [
      'TAAWWWRRRRRRRRRRRRRRWWWBBH',
      'BBAAAARRRRRRRRRRRRRLGGGBBB',
      'BBAAARRRRRRRRRRRRRRLGGGBBB',
      'BBAAARRRRRRRRRRRRRRLGGGBBB',
      'BBAAAARRRRRRRRRRRRRLGGGBBB',
      'TAAWWWRRRRRRRRRRRRRRWWWBAH',
    ],
  ],
  police: [
    // A sedan in livery, the light bar across its roof.
    [
      '.TAAWWWBBBBBBBBBDWWWBBA.',
      'TAAGGGGGGGGGGGGGGGGGBBBH',
      'BBAGGRRRRRLLRRRRGGGGBBBB',
      'BBAGGRRRRRLLRRRRGGGGBBBB',
      'BBAGGRRRRRLLRRRRGGGGBBBB',
      'BBAGGRRRRRLLRRRRGGGGBBBB',
      'TAAGGGGGGGGGGGGGGGGGBBBH',
      '.TAAWWWBBBBBBBBBDWWWBBA.',
    ],
  ],
  firetruck: [
    // Hose bed and ladder behind a light bar, the crew cab's windows ahead of it.
    [
      'TBWWWBBBBBBBBBBBBBBBWWWBBBBH',
      'BBBBBBDDDDDDDDDDDDDLLGGGGBBB',
      'BDDBBBDLDLDLDLDLDLDLLGGGGBBB',
      'BDDBBBDLDLDLDLDLDLDLLGGGGBBB',
      'BBBBBBDDDDDDDDDDDDDLLGGGGBBB',
      'TBWWWBBBBBBBBBBBBBBBWWWBBBBH',
    ],
  ],
  'box-cart': [
    // A closed box under a little roof, wheels and a lamp.
    [
      'DDAWRRRRWAD.',
      'BDARRRRRRAD.',
      'BDRRRHHRRRBB',
      'BDRRRHHRRRBB',
      'BDARRRRRRAD.',
      'DDAWRRRRWAD.',
    ],
  ],
  'fry-cart': [
    // A hot pan set into a steel counter, with its side shelf.
    [
      'DDWBBBBBBWDD',
      'BBBGGGGGABBB',
      'BBGGDDDGGABB',
      'BBGGDDDGGABB',
      'BBBGGGGGABBB',
      'DDWBBBBBBWDD',
    ],
  ],
  'flatbed-cart': [
    // A slatted bed with goods stacked in the middle, wheels at its sides.
    [
      'DDWBBBBBBWDD',
      'BDDRRAARRBBB',
      'BDLRRAARRLBB',
      'BDLRRAARRLBB',
      'BDDRRAARRBBB',
      'DDWBBBBBBWDD',
    ],
  ],
} as const satisfies Record<string, readonly (readonly string[])[]>;

/** Which of its fine plans a craft shows, from a hash of its identity, never a random draw. */
export const lookOf = (identity: number) => (Math.imul(identity, 2654435761) >>> 16) & 0xffff;
