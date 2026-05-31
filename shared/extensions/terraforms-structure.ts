// Terraforms Hypercastle structure constants mirrored from the deployed contract sources.
export const TERRAFORMS_HYPERCASTLE_LEVEL_COUNT = 20;

// Terraforms levels are centered inside a 48 by 48 maximum footprint.
export const TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION = 48;

// Terraforms biome selection uses nine weighted biome groups per level.
export const TERRAFORMS_BIOME_GROUP_COUNT = 9;

// Terraforms topography maps terrain values into nine height buckets.
export const TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT = 9;

// Terraforms metadata should label question-mark density as Resource in ArtGod UI.
export const TERRAFORMS_RESOURCE_ATTRIBUTE_KEY = "Resource";

// Terraforms metadata stores the Zone name under this trait key.
export const TERRAFORMS_ZONE_ATTRIBUTE_KEY = "Zone";

// Terraforms metadata stores the Biome number under this trait key.
export const TERRAFORMS_BIOME_ATTRIBUTE_KEY = "Biome";

// Terraforms metadata stores the Hypercastle level number under this trait key.
export const TERRAFORMS_LEVEL_ATTRIBUTE_KEY = "Level";

// Level square dimensions from TerraformsDataStorage.levelDimensions.
export const TERRAFORMS_LEVEL_DIMENSIONS = [
    4, 8, 8, 16, 16, 24, 24, 24, 16, 32, 32, 16, 48, 48, 24, 24, 16, 8, 8, 4,
] as const;

// Terrain thresholds from TerraformsDataStorage.topography.
export const TERRAFORMS_TOPOGRAPHY_THRESHOLDS = [
    18000, 12000, 4000, -4000, -12000, -20000, -22000, -26000,
] as const;

// Zone window start indices from TerraformsDataStorage.zoneStartingIndex.
export const TERRAFORMS_ZONE_STARTING_INDICES = [
    74, 74, 74, 74, 71, 65, 60, 54, 51, 43, 36, 34, 25, 17, 8, 1, 0, 0, 0, 0,
] as const;

// Zone window sizes from TerraformsDataStorage.zonesOnLevel.
export const TERRAFORMS_ZONES_ON_LEVEL = [
    1, 1, 1, 1, 3, 6, 5, 6, 3, 8, 7, 2, 9, 8, 9, 7, 1, 1, 1, 1,
] as const;

// Biome group start indices from TerraformsDataStorage.charsetIndices.
export const TERRAFORMS_BIOME_GROUP_START_INDICES = [
    0, 21, 43, 50, 59, 66, 73, 77, 83,
] as const;

// Biome group lengths from TerraformsDataStorage.charsetLengths.
export const TERRAFORMS_BIOME_GROUP_LENGTHS = [
    21, 22, 7, 9, 7, 7, 4, 6, 9,
] as const;

// Per-level biome group weights from TerraformsDataStorage.charsetWeights.
export const TERRAFORMS_BIOME_GROUP_WEIGHTS_BY_LEVEL = [
    [0, 50, 0, 0, 0, 0, 0, 0, 50],
    [22, 11, 11, 11, 11, 11, 1, 11, 11],
    [22, 11, 11, 11, 11, 11, 1, 11, 11],
    [5, 0, 5, 90, 0, 0, 0, 0, 0],
    [10, 3, 1, 5, 1, 2, 1, 0, 77],
    [30, 55, 5, 5, 2, 2, 1, 0, 0],
    [20, 18, 30, 20, 5, 5, 1, 1, 0],
    [25, 32, 5, 5, 30, 2, 1, 0, 0],
    [10, 3, 1, 5, 1, 2, 1, 0, 77],
    [20, 20, 14, 14, 10, 10, 1, 1, 10],
    [20, 20, 14, 14, 10, 10, 1, 1, 10],
    [30, 55, 5, 5, 2, 2, 1, 0, 0],
    [10, 20, 18, 25, 15, 10, 1, 1, 0],
    [10, 30, 25, 18, 5, 10, 1, 1, 0],
    [10, 30, 25, 18, 5, 10, 1, 1, 0],
    [10, 20, 18, 25, 15, 10, 1, 1, 0],
    [22, 11, 11, 11, 11, 11, 1, 11, 11],
    [5, 5, 10, 5, 5, 14, 1, 5, 50],
    [50, 25, 0, 0, 0, 0, 0, 0, 25],
    [0, 100, 0, 0, 0, 0, 0, 0, 0],
] as const;

// Biome font sizes from TerraformsDataStorage.charsetFontsizes.
export const TERRAFORMS_BIOME_FONT_SIZES = [
    27, 18, 18, 18, 26, 23, 23, 18, 22, 18, 18, 18, 22, 18, 17, 18, 18, 26,
    14, 18, 20, 20, 22, 18, 13, 20, 22, 22, 22, 22, 20, 22, 15, 15, 18, 24,
    23, 14, 18, 18, 16, 20, 25, 14, 15, 16, 12, 12, 12, 18, 15, 16, 16, 16,
    11, 12, 15, 12, 14, 14, 16, 16, 13, 13, 14, 12, 13, 11, 12, 12, 10, 9,
    9, 14, 11, 12, 14, 16, 12, 12, 12, 14, 14, 12, 14, 15, 17, 22, 17, 14,
    14, 14,
] as const;

const ZONE_NAMES = [
    "Alto",
    "Ouallada",
    "Mould",
    "Blossom",
    "Greysunn",
    "Treasure",
    "Uwo",
    "Dread",
    "Venmon",
    "Blushing",
    "Linosim",
    "pfpfpfpbbx80",
    "Pepo",
    "Avidana",
    "Shahra",
    "Antenna",
    "Gemina",
    "Holo",
    "Shiro",
    "Mirage",
    "Hyphae",
    "Riso",
    "Exduo",
    "Radiant",
    "Warp",
    "Mecha",
    "Grove",
    "Nightrose",
    "Hypermage",
    "Arc",
    "Dynacrypts",
    "Aetherking",
    "Valeria",
    "Killscreen",
    "Palace",
    "Muxtai X1",
    "[HOME]",
    "[MENU]",
    "[BOSS]",
    "[BLOOD]",
    "[DARK]",
    "[WEN]",
    "[SOON]",
    "[MOON]",
    "[NEON]",
    "[CUR2]",
    "[HYCA]",
    "[YUNA]",
    "[SEP]",
    "[NOV]",
    "[SUN]",
    "Dhampir",
    "Aria",
    "Wastelands",
    "Promiselands",
    "Cradle",
    "Everglades",
    "Kippsun",
    "Calyx",
    "Akileaf",
    "Mt Zuka",
    "First Earth",
    "Zerinia",
    "Intro Forest",
    "Jadeite",
    "Rocket",
    "Toad",
    "Ender",
    "Bubble",
    "Angel",
    "Mori",
    "Xleph",
    "Tetsu",
    "Royal",
    "Kairo",
] as const;

const ZONE_COLORS = [
    ["#303030","#0974f8","#fe81dd","#ff9000","#006e15","#fe81dd","#fbd81c","#608a1a","#202020","#e4e6f2"],
    ["#078e56","#b14e39","#03643b","#cf553d","#284356","#e05534","#f7e7c6","#282c2f","#0a8b3b","#171717"],
    ["#87e899","#e2efed","#edf6f7","#ac7167","#e93e5b","#4c26c6","#ff63e9","#fefe82","#4dcb7e","#252525"],
    ["#ef5ea1","#efeded","#a2b0e5","#b65293","#c7bfe3","#2c3a8d","#ca579e","#4d334c","#48358f","#171717"],
    ["#bbbbbb","#282828","#292929","#242424","#393939","#323232","#242424","#313131","#343434","#202020"],
    ["#323232","#ffadde","#7ffcc4","#7ffcc4","#7ffcc4","#7ffcc4","#7ffcc4","#ffadde","#ffe481","#323232"],
    ["#1e1e1e","#d0daeb","#f6afbc","#1e1e1e","#eae6df","#d0daeb","#f6afbc","#b0d6fa","#1e1e1e","#1e1e1e"],
    ["#322c41","#312c41","#89a8b9","#84488b","#453747","#392236","#4a6189","#84488b","#312c41","#2e2a39"],
    ["#aec5ed","#f1db65","#e12e5d","#f598c0","#f9d8ee","#eed2c0","#ef2647","#5cd3e5","#248ac0","#e0e0dd"],
    ["#9c89b8","#f0a6ca","#efc3e6","#b8bedd","#f0e6ef","#9c89b8","#f0a6ca","#efc3e6","#b8bedd","#f0e6ef"],
    ["#404040","#29af3f","#dcc729","#26abd4","#29af3f","#dcc729","#26abd4","#29af3f","#404040","#c3c3c3"],
    ["#f772b5","#435d5a","#5a7b70","#5a7b70","#5a7b70","#e83b3b","#ccdf6d","#aede6a","#ffffff","#e4dde7"],
    ["#d77c11","#d3cac3","#61785c","#3f5c39","#d77c11","#d3cac3","#332a1d","#303d2d","#d77c11","#d3cac3"],
    ["#543e2e","#fcd265","#db4f54","#543e2e","#fcd265","#db4f54","#7ca9bf","#faf8f5","#e67d32","#ebe4d8"],
    ["#6b3b77","#2b2b2b","#cda254","#92609d","#aa4a4e","#7a5986","#2b2b2b","#cda254","#92609d","#d0d5db"],
    ["#f4d35e","#ee964b","#f95738","#083d77","#f4d35e","#ee964b","#f95738","#083d77","#083d77","#ebebd3"],
    ["#1e1e1e","#d0daeb","#f6afbc","#1e1e1e","#eae6df","#1e1e1e","#eae6df","#b0d6fa","#1e1e1e","#e6e8e5"],
    ["#fc5602","#f2d601","#1182c0","#fb71c9","#761fa5","#256006","#0577bd","#fcdf02","#fc6e03","#eee8de"],
    ["#7ffcc4","#ffe481","#ffcfb7","#505050","#505050","#505050","#505050","#ffe481","#7ffcc4","#f2e7ea"],
    ["#17742e","#f53fad","#17742e","#f53fad","#17742e","#17742e","#f53fad","#17742e","#f53fad","#f5eee8"],
    ["#328dfd","#f0f0f0","#e65700","#328dfd","#f0f0f0","#e65700","#328dfd","#f0f0f0","#e65700","#f0f0f0"],
    ["#ff474a","#3a3e94","#ff363b","#3a3e94","#ff363b","#3a3e94","#ff363b","#3a3e94","#ff363b","#dadadd"],
    ["#0012b5","#0012b5","#fff7f5","#fff7f5","#0012b5","#0012b5","#fff7f5","#fff7f5","#0012b5","#ffe6fe"],
    ["#62d840","#bed002","#ff2e1e","#70d0ce","#3cb4e0","#04b2b9","#ff6c03","#f4bcb4","#fdec00","#eeeeee"],
    ["#e5291e","#d3d3d3","#8b3ede","#e5291e","#d3d3d3","#8b3ede","#e5291e","#d3d3d3","#8b3ede","#dfdfdf"],
    ["#e84629","#272c38","#e8e1df","#a482b9","#e84629","#272c38","#e8e1df","#a482b9","#eee8e1","#1e2833"],
    ["#fb8b01","#399c42","#0b704e","#f34509","#f34509","#f34509","#6f9d80","#0b704e","#fb7712","#10151b"],
    ["#00684e","#efd4fd","#2b358e","#ffdae4","#2a358f","#383e9c","#9c58af","#036242","#fedff1","#1c1e2b"],
    ["#e40513","#fefefe","#fefefe","#c9cdc3","#e40513","#0173b8","#c9cdc3","#272022","#c9cdc3","#1a1a1a"],
    ["#ec5526","#ec5526","#f7f4e2","#9ebbc1","#f4ac12","#1e1b1e","#ec5526","#f7f4e2","#9ebbc1","#1e1b1e"],
    ["#f98284","#feaae4","#b0a9e4","#accce4","#b3e3da","#b0eb93","#fff7a0","#ffc384","#dea38b","#28282e"],
    ["#a9df4f","#3dddb0","#ebeceb","#a9df4f","#3dddb0","#ebeceb","#a9df4f","#3dddb0","#a9df4f","#302f30"],
    ["#fe004f","#04a15c","#fd8901","#fe004f","#04a15c","#fd8901","#fe004f","#04a15c","#fd8901","#2c2827"],
    ["#ffe401","#fe0000","#fa7eb9","#fb7dba","#062d8d","#fe0000","#feeae8","#fe0000","#ffe401","#151515"],
    ["#c1c6cc","#bbac69","#e24e32","#c1c6cc","#262523","#bbac69","#e04f34","#e24e32","#beaf6e","#e24e32"],
    ["#ffcad5","#082496","#ed0e0a","#f5f2e3","#ffcad5","#082496","#f5f2e3","#30a5ff","#082496","#ed0e0a"],
    ["#303030","#303030","#303030","#303030","#303030","#303030","#303030","#303030","#303030","#fff5e6"],
    ["#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#000084"],
    ["#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#f8f7ff","#ee0000"],
    ["#ee0000","#ee0000","#ee0000","#ee0000","#ee0000","#ee0000","#ee0000","#ee0000","#ee0000","#202020"],
    ["#eeeeee","#eeeeee","#eeeeee","#eeeeee","#eeeeee","#eeeeee","#eeeeee","#eeeeee","#eeeeee","#303030"],
    ["#fffdf0","#fffdf0","#fffdf0","#fffdf0","#fffdf0","#fffdf0","#fffdf0","#fffdf0","#fffdf0","#1e1c32"],
    ["#ffaa00","#ffaa00","#ffaa00","#ffaa00","#ffaa00","#ffaa00","#ffaa00","#ffaa00","#ffaa00","#222222"],
    ["#9cb7d4","#35443b","#9cb7d4","#35443b","#9cb7d4","#35443b","#9cb7d4","#35443b","#9cb7d4","#35443b"],
    ["#9cd4a8","#35443b","#9cd4a8","#35443b","#9cd4a8","#35443b","#9cd4a8","#35443b","#9cd4a8","#35443b"],
    ["#8e918c","#8e918c","#8e918c","#8e918c","#8e918c","#8e918c","#8e918c","#8e918c","#8e918c","#eff1f4"],
    ["#303030","#303030","#303030","#303030","#303030","#303030","#303030","#303030","#303030","#ffc800"],
    ["#f1c8ff","#f1c8ff","#f1c8ff","#f1c8ff","#f1c8ff","#f1c8ff","#f1c8ff","#f1c8ff","#f1c8ff","#000a1d"],
    ["#303030","#303030","#303030","#303030","#303030","#303030","#303030","#303030","#303030","#9f82ff"],
    ["#303030","#303030","#303030","#303030","#303030","#303030","#303030","#303030","#303030","#ff4538"],
    ["#292c34","#292c34","#292c34","#292c34","#292c34","#292c34","#292c34","#292c34","#292c34","#ff9a72"],
    ["#eb4034","#eb4034","#eeeeee","#eeeeee","#eeeeee","#eb4034","#eb4034","#eb4034","#eb4034","#202020"],
    ["#93d1de","#93d1de","#718dbc","#718dbc","#f9a4cb","#dad7cc","#f8fefe","#f6e518","#ec7e15","#292726"],
    ["#ff0e0e","#fbf0df","#2f3635","#52665c","#688679","#fff0ee","#fbf0df","#2f3635","#52665c","#1a1e1d"],
    ["#6db217","#6db217","#6db217","#6db217","#6db217","#6db217","#fde023","#fd122c","#fe2a95","#0a2131"],
    ["#efc201","#104d28","#e0632b","#cec4be","#43882f","#90ad27","#ffe7d3","#de797d","#efc201","#104d28"],
    ["#f5eee8","#f53fad","#f5eee8","#f53fad","#f5eee8","#f53fad","#f5eee8","#f53fad","#f5eee8","#17742e"],
    ["#045939","#e2b8d1","#6390b5","#fff4c0","#60a278","#b1becd","#66aeb6","#a0a9b8","#60a278","#081612"],
    ["#90f1ef","#ed553f","#419c87","#f1bdd4","#82cdef","#20201e","#846daf","#fef9f5","#f1bdd4","#419c87"],
    ["#453687","#4899c4","#b771b9","#3c2b71","#82c1c6","#3c2b71","#095474","#96c7ce","#f9fbd4","#abe291"],
    ["#f0f6e8","#93d4b5","#93d4b5","#f0dab1","#e39aac","#c45d9f","#634b7d","#2ba9b4","#6461c2","#221039"],
    ["#cb8175","#e2a97e","#f0cf8e","#f6edcd","#f6edcd","#a8c8a6","#a8c8a6","#6d8d8a","#655057","#32282b"],
    ["#e6ceac","#cdba94","#cdba94","#bda583","#a48d6a","#8b7d62","#73654a","#524839","#524839","#292418"],
    ["#399c42","#399c42","#307d39","#005d1a","#369e40","#1a5425","#00300f","#33953e","#369e40","#1a1814"],
    ["#5f9644","#5f9644","#32523a","#c4a675","#c4a675","#c4a675","#7bb03e","#cad795","#cad795","#e2dfd4"],
    ["#ed1111","#f8f7ff","#f8f7ff","#0012b5","#0012b5","#0012b5","#0012b5","#f8f7ff","#f8f7ff","#30e7ff"],
    ["#ffa8ee","#eceb80","#008080","#ffe330","#72b802","#e85bcc","#a28ef4","#ff0e0e","#b0e111","#8ac163"],
    ["#ff4fe2","#f8f7ff","#ff4fe2","#ff4fe2","#ff4fe2","#ff4fe2","#ff4fe2","#ff4fe2","#f8f7ff","#0000ff"],
    ["#f5221f","#fb72d9","#f7c4de","#ffffff","#f23c19","#fff21f","#167833","#fb72d9","#f5221f","#2b24ad"],
    ["#f6d903","#eceff2","#ff6650","#f3b2e0","#83dbf7","#06917e","#e0f2fa","#cbeddf","#e7e9ef","#0dcdee"],
    ["#eac802","#daa7ac","#daa7ac","#daa7ac","#daa7ac","#daa7ac","#eac802","#329160","#3db7a9","#16160f"],
    ["#c7c7c7","#c7c7c7","#9ff240","#6c6c6c","#6c6c6c","#6c6c6c","#c9c9c9","#c9c9c9","#c9c9c9","#202020"],
    ["#e9e3d5","#e3b0bc","#171717","#171717","#da709a","#da709a","#db759d","#c01d10","#c72612","#171717"],
    ["#f9eddd","#f2d3ab","#f2d3ab","#c69fa5","#c69fa5","#8b6d9c","#ffc7fc","#700000","#f2d3ab","#171616"],
    ["#ffe596","#ffad3b","#ffad3b","#c57938","#c57938","#975330","#975330","#574729","#574729","#313638"],
] as const;

const BIOME_CHARACTER_SETS = [
    ["▆","▇","▆","▇","▉","▊","▋","█","▊"],
    ["▚","▛","▜","▙","▗","▘","▝","▟","▞"],
    ["▇","▚","▚","▚","▞","▞","▞","▞","▇"],
    ["▅","▂","▅","▃","▂","▃","▃","▂","▅"],
    ["▅","▂","▃","▃","▂","▃","▃","▂","▆"],
    ["█","▂","▂","▂","▂","▂","▂","▂","█"],
    ["▂","█","▂","▂","▂","▂","█","█","▂"],
    ["█","▄","░","░","▒","▓","▀","░","▄"],
    ["▝","▒","▛","▒","▝","▅","░","░","▒"],
    ["█","▓","░","░","▒","▒","▒","▒","▓"],
    ["▌","▄","█","░","▒","▓","▓","▀","▐"],
    ["█","▌","▐","▄","▀","░","▒","▓","▓"],
    ["▉","―","―","▉","―","―","―","―","▆"],
    ["░","░","█","▄","▒","▓","▀","░","▄"],
    ["░","░","▒","▓","▓","▒","▒","▒","░"],
    ["⛆","░","░","⛆","⛆","⛆","░","▒","▒"],
    ["⛆","▒","░","▓","▓","▓","░","▒","⛆"],
    ["⛆","░","+","+","+","+","▒","▒","▒"],
    ["█","╔","╔","╣","═","╣","═","╣","█"],
    ["╚","░","░","╝","═","╣","═","═","╝"],
    ["╝","═","╣","░","░","╔","═","═","▒"],
    ["═","╚","╔","⾂","⾂","⾂","═","╝","═"],
    ["▒","?","▒","☎","☎","▒","?","☆","░"],
    ["?","?","░","⾂","▒","░","?","?","?"],
    ["?","╣","╔","╣","╚","═","╔","?","?"],
    ["?","░","➫","⋆",".","➫","░","░","?"],
    ["?","?","░","♖","░","░","?","░","♘"],
    ["?","?","░","?","░","?","?","░","♖"],
    ["?","░","?","⋆","?","?","░","░","?"],
    ["?","░","?","⋆","?","⛱","░","░","⛱"],
    ["⛓","░","❀","?","❀","⛓","❀","░","⛓"],
    ["⛓","░","?","?","?","⛓","➫","░","⛓"],
    ["?","⛓","⛓","⛓","⛓","⛓","⛓","⛓","?"],
    ["?","⛓","⛓","⛓","⛓","⛓","⛓","⛓","?"],
    ["?","█","█","╣","═","╣","▄","█","?"],
    ["?","█","█","█","█","█","█","█","?"],
    ["?","▂","▅","▅","▅","▂","▂","?","?"],
    ["?","⛓","?","█","█","█","?","⛓","?"],
    ["♘","♜","▂","▂","▂","♜","♜","♜","♖"],
    ["♜","♘"," "," "," ","♖","♖","♖","♜"],
    ["❀","⋮","⋮","⋮","❀","❀","⋮","⋮","❀"],
    ["⛓","░","?","?","?","?","▒","░","⛓"],
    ["⛆","༽","༼","༼","༼","༼","༼","༽","⛆"],
    ["░","░","⋆","░",".","░","░","░","?"],
    ["?","⛆","░","░","⛱","⋰","⋰","⋰","⋰"],
    ["⋮","⋮","⋮","⋮","⋮","░","░","░","░"],
    ["❀",".",".","⫯","⫯",".",".","⫯","❀"],
    ["⛫","⛫","⛫","⋰","⋰","⋰","⛫","⛫","⛫"],
    ["⚑","⋰","⋰","⋰","⋰","⋰","⋰","⋰","?"],
    ["?","═","═","═","═","═","═","═","?"],
    ["?","?","?","?","⩎","⛆","⍝","⛆","⍝"],
    ["⍝",".","░","░","░",".",".","✗","⍝"],
    ["⋰","⋰","⋮","⋮","⋮","⋯","⋯","⋱","⋱"],
    ["?","?","?","?","?","?","⛓","⛓","⛓"],
    ["?","?","0","0","1","1","0","0","?"],
    ["?",".",".","⇩","⇩",".",".","?","?"],
    ["⟰","⋮","⋮","⫯","⋮","⋮","⟰","⟰","⟰"],
    [".",".","#","#","#","#","#","#","⛫"],
    ["0","0","0",".",".","1","1","1","1"],
    ["⌬","╚","╔","╣","╣","═","═","═","⌬"],
    ["⎛","⎛","░","░","░","░","░","⎞","⎞"],
    ["❀","⋮","⋮","༽","༽","⋮","⋮","⋮","❀"],
    ["?","?","?","?","?","?","?","?","?"],
    ["⌬","༼","༼","༼","༼","༼","༼","༼","⌬"],
    ["⋮","⋮","⋮","⌬","⌬","⋮","⋮","⋮","?"],
    ["༼","༼","༼","༽","༽","༽","༽","༽","༽"],
    ["?","?","?","?","?","?","?","?","?"],
    ["✎","༽","༽","༽","༽","༽","༽","༽","✎"],
    ["♥","♡",".",".","?","?",".",".","♡"],
    ["?","═","═","═","═","═","═","?","?"],
    ["?","═","═","═","═","═","═","?","?"],
    ["?","♥","♥","g","m","♥","♥","♥","?"],
    ["?","♥","♥","城","城","♥","♥","♥","?"],
    ["?","?","?","?","?","?","?","?","?"],
    ["░","░","░","?","?","?","?","?","░"],
    ["지","지","지","-","-","-","역","역","역"],
    ["?","?","?","?","城","城","?","?","?"],
    ["▧","═","═","▧","═","═","═","▧","▧"],
    ["▧","▧","⬚","▧","⬚","⬚","⬚","▧","▧"],
    ["▩","▩","▧","?","?","?","?","▧","▩"],
    ["◩","◩","◪",".",".","◩","◩","◪","◪"],
    ["◩","◪","◪","⛆","⛆","◩","◩","◩","⛆"],
    ["╳","╱","╱","╱","╳","╲","╲","╲","╳"],
    ["?","⚑","⚑","⚑","⚑","⚑","⚑","⚑","★"],
    ["_","_","_","|","|","|","_","|","|"],
    ["♜","♖","░","░","░","░","♘","♘","♛"],
    ["?","?","?","?","?","?","?","?","?"],
    ["▂","✗","✗","⛆","⛆","✗","✗","⛆","▂"],
    ["{","}","-","-","-","%","%","%","%"],
    ["0",".",".",".","-","^",".",".","/"],
    ["_","~","~","~","~",".","*","⫯","❀"],
    ["?","╚","╔","╣","╣","═","═","═","⛓"],
] as const;

const BIOME_FONT_IDS = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2,
    2, 1, 5, 3, 3, 5, 7, 4, 5, 5, 5, 1, 1, 2, 2, 6, 6, 9, 5, 9, 7, 7, 7,
    13, 7, 7, 1, 8, 7, 7, 6, 6, 9, 8, 8, 6, 1, 6, 9, 9, 9, 9, 9, 10, 9,
    10, 10, 10, 10, 10, 11, 1, 11, 11, 11, 11, 11, 11, 11, 12, 12, 13, 6,
    12, 12, 13, 13, 13, 1,
] as const;

// A Terraforms Zone is a named palette selected from per-level topography buckets.
export type TerraformsZone = {
    readonly index: number;
    readonly name: string;
    readonly palette: readonly string[];
};

// A Terraforms Biome maps its numeric index to nine glyphs and font metadata.
export type TerraformsBiome = {
    readonly index: number;
    readonly groupIndex: number;
    readonly characters: readonly string[];
    readonly fontId: number;
    readonly fontSize: number;
};

// Biome groups are contiguous index windows used by per-level contract weights.
export type TerraformsBiomeGroup = {
    readonly groupIndex: number;
    readonly startIndex: number;
    readonly length: number;
    readonly biomeIndices: readonly number[];
};

// Level biome weights are the original contract rarity rules for biome groups.
export type TerraformsBiomeGroupWeight = {
    readonly groupIndex: number;
    readonly weightPercent: number;
    readonly biomeIndices: readonly number[];
};

// Topography buckets map terrain thresholds to elevation and Zone selection.
export type TerraformsTopographyBucket = {
    readonly topographyBucketIndex: number;
    readonly thresholdGreaterThan: number | null;
    readonly elevation: number;
};

// Per-level Zone buckets show how topography buckets choose Zone windows.
export type TerraformsLevelZoneBucket = TerraformsTopographyBucket & {
    readonly zoneIndex: number;
    readonly zoneName: string;
};

// A Hypercastle level summary contains only contract-derived structural data.
export type TerraformsLevelSummary = {
    readonly levelNumber: number;
    readonly levelIndex: number;
    readonly dimension: number;
    readonly parcelCount: number;
    readonly zoneStartIndex: number;
    readonly zoneCount: number;
    readonly zones: readonly TerraformsZone[];
    readonly topographyZoneBuckets: readonly TerraformsLevelZoneBucket[];
    readonly biomeGroupWeights: readonly TerraformsBiomeGroupWeight[];
    readonly availableBiomeGroupWeights: readonly TerraformsBiomeGroupWeight[];
};

// Level groups collect levels with identical Zone-set relationships.
export type TerraformsLevelGroupSummary = {
    readonly groupId: string;
    readonly levelNumbers: readonly number[];
    readonly zoneIndices: readonly number[];
    readonly zoneNames: readonly string[];
    readonly maxDimension: number;
    readonly totalParcels: number;
};

// Contract-derived total parcel count across all Hypercastle levels.
export const TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS =
    TERRAFORMS_LEVEL_DIMENSIONS.reduce((sum, dimension) => sum + dimension ** 2, 0);

// Contract-derived Zone catalog with names and 10-color palettes.
export const TERRAFORMS_ZONES: readonly TerraformsZone[] = ZONE_NAMES.map(
    (name, index) => ({
        index,
        name,
        palette: ZONE_COLORS[index],
    }),
);

// Contract-derived biome group catalog used by per-level weights.
export const TERRAFORMS_BIOME_GROUPS: readonly TerraformsBiomeGroup[] =
    TERRAFORMS_BIOME_GROUP_START_INDICES.map((startIndex, groupIndex) => {
        const length = TERRAFORMS_BIOME_GROUP_LENGTHS[groupIndex];
        return {
            groupIndex,
            startIndex,
            length,
            biomeIndices: range(startIndex, length),
        };
    });

// Contract-derived Biome catalog with character sets and font metadata.
export const TERRAFORMS_BIOMES: readonly TerraformsBiome[] =
    BIOME_CHARACTER_SETS.map((characters, index) => ({
        index,
        groupIndex: resolveTerraformsBiomeGroupIndex(index),
        characters,
        fontId: BIOME_FONT_IDS[index],
        fontSize: TERRAFORMS_BIOME_FONT_SIZES[index],
    }));

// Contract-derived topography buckets used for elevation and Zone selection.
export const TERRAFORMS_TOPOGRAPHY_BUCKETS: readonly TerraformsTopographyBucket[] =
    Array.from({ length: TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT }, (_, index) => ({
        topographyBucketIndex: index,
        thresholdGreaterThan: TERRAFORMS_TOPOGRAPHY_THRESHOLDS[index] ?? null,
        elevation: 4 - index,
    }));

// Contract-derived level summaries for the full 20-level Hypercastle.
export const TERRAFORMS_HYPERCASTLE_LEVELS: readonly TerraformsLevelSummary[] =
    TERRAFORMS_LEVEL_DIMENSIONS.map((_, levelIndex) =>
        buildTerraformsLevelSummary(levelIndex + 1),
    );

// Contract-derived level groups keyed by identical Zone sets.
export const TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS: readonly TerraformsLevelGroupSummary[] =
    buildTerraformsLevelGroups(TERRAFORMS_HYPERCASTLE_LEVELS);

// Resolves the biome group that owns a concrete Biome index.
export function resolveTerraformsBiomeGroupIndex(biomeIndex: number): number {
    const group = TERRAFORMS_BIOME_GROUPS.find(
        (candidate) =>
            biomeIndex >= candidate.startIndex &&
            biomeIndex < candidate.startIndex + candidate.length,
    );
    if (!group) {
        throw new RangeError(`Unknown Terraforms biome index: ${biomeIndex}`);
    }
    return group.groupIndex;
}

// Resolves a Solidity level number to its zero-based storage index.
export function resolveTerraformsLevelIndex(levelNumber: number): number {
    if (
        !Number.isInteger(levelNumber) ||
        levelNumber < 1 ||
        levelNumber > TERRAFORMS_HYPERCASTLE_LEVEL_COUNT
    ) {
        throw new RangeError(`Unknown Terraforms level number: ${levelNumber}`);
    }
    return levelNumber - 1;
}

// Mirrors TerraformsData.heightmapIndexFromTerrainValue for static analysis.
export function resolveTerraformsTopographyBucket(
    terrainValue: number,
): number {
    for (let index = 0; index < TERRAFORMS_TOPOGRAPHY_THRESHOLDS.length; index++) {
        if (terrainValue > TERRAFORMS_TOPOGRAPHY_THRESHOLDS[index]) {
            return index;
        }
    }
    return TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT - 1;
}

// Resolves the Zone index selected by a level and topography bucket.
export function resolveTerraformsZoneIndexForTopographyBucket(input: {
    levelNumber: number;
    topographyBucketIndex: number;
}): number {
    const levelIndex = resolveTerraformsLevelIndex(input.levelNumber);
    if (
        !Number.isInteger(input.topographyBucketIndex) ||
        input.topographyBucketIndex < 0 ||
        input.topographyBucketIndex >= TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT
    ) {
        throw new RangeError(
            `Unknown Terraforms topography bucket: ${input.topographyBucketIndex}`,
        );
    }
    return (
        TERRAFORMS_ZONE_STARTING_INDICES[levelIndex] +
        (input.topographyBucketIndex % TERRAFORMS_ZONES_ON_LEVEL[levelIndex])
    );
}

// Builds the contract-derived summary for one Hypercastle level.
export function buildTerraformsLevelSummary(
    levelNumber: number,
): TerraformsLevelSummary {
    const levelIndex = resolveTerraformsLevelIndex(levelNumber);
    const dimension = TERRAFORMS_LEVEL_DIMENSIONS[levelIndex];
    const zoneStartIndex = TERRAFORMS_ZONE_STARTING_INDICES[levelIndex];
    const zoneCount = TERRAFORMS_ZONES_ON_LEVEL[levelIndex];
    const zones = TERRAFORMS_ZONES.slice(zoneStartIndex, zoneStartIndex + zoneCount);
    const biomeGroupWeights = TERRAFORMS_BIOME_GROUP_WEIGHTS_BY_LEVEL[
        levelIndex
    ].map((weightPercent, groupIndex) => ({
        groupIndex,
        weightPercent,
        biomeIndices: TERRAFORMS_BIOME_GROUPS[groupIndex].biomeIndices,
    }));

    return {
        levelNumber,
        levelIndex,
        dimension,
        parcelCount: dimension ** 2,
        zoneStartIndex,
        zoneCount,
        zones,
        topographyZoneBuckets: TERRAFORMS_TOPOGRAPHY_BUCKETS.map((bucket) => {
            const zoneIndex = resolveTerraformsZoneIndexForTopographyBucket({
                levelNumber,
                topographyBucketIndex: bucket.topographyBucketIndex,
            });
            return {
                ...bucket,
                zoneIndex,
                zoneName: TERRAFORMS_ZONES[zoneIndex].name,
            };
        }),
        biomeGroupWeights,
        availableBiomeGroupWeights: biomeGroupWeights.filter(
            (group) => group.weightPercent > 0,
        ),
    };
}

// Builds reviewable level groups from identical per-level Zone sets.
export function buildTerraformsLevelGroups(
    levels: readonly TerraformsLevelSummary[],
): readonly TerraformsLevelGroupSummary[] {
    const groupsByZoneSignature = new Map<string, TerraformsLevelSummary[]>();
    for (const level of levels) {
        const signature = level.zones.map((zone) => zone.index).join(",");
        groupsByZoneSignature.set(signature, [
            ...(groupsByZoneSignature.get(signature) ?? []),
            level,
        ]);
    }

    return [...groupsByZoneSignature.values()].map((groupLevels) => {
        const levelNumbers = groupLevels.map((level) => level.levelNumber);
        const zones = groupLevels[0].zones;
        return {
            groupId: buildLevelGroupId(levelNumbers),
            levelNumbers,
            zoneIndices: zones.map((zone) => zone.index),
            zoneNames: zones.map((zone) => zone.name),
            maxDimension: Math.max(...groupLevels.map((level) => level.dimension)),
            totalParcels: groupLevels.reduce((sum, level) => sum + level.parcelCount, 0),
        };
    });
}

function buildLevelGroupId(levelNumbers: readonly number[]): string {
    if (levelNumbers.length === 1) {
        return `level-${levelNumbers[0]}`;
    }
    return `levels-${levelNumbers[0]}-${levelNumbers[levelNumbers.length - 1]}`;
}

function range(start: number, length: number): number[] {
    return Array.from({ length }, (_, offset) => start + offset);
}
