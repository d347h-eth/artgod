// User-facing labels for Terraforms collection extension pages.
export const TERRAFORMS_EXTENSION_PAGE_LABELS = {
	Hypercastle: 'hypercastle'
} as const;

// Stable catalog ids for the Terraforms Hypercastle explorer.
export const TERRAFORMS_HYPERCASTLE_CATALOG_KEYS = {
	Levels: 'levels',
	Zones: 'zones',
	Biomes: 'biomes'
} as const;

// Stable query params owned by the Terraforms Hypercastle explorer.
export const TERRAFORMS_HYPERCASTLE_QUERY_PARAMS = {
	Group: 'group',
	Level: 'level',
	Catalog: 'catalog',
	Sort: 'sort',
	Direction: 'dir'
} as const;

// Stable sort directions for shareable Terraforms Hypercastle catalog URLs.
export const TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS = {
	Asc: 'asc',
	Desc: 'desc'
} as const;

// Stable sort keys for the Terraforms Hypercastle catalog tables.
export const TERRAFORMS_HYPERCASTLE_SORT_KEYS = {
	Level: 'level',
	Parcels: 'parcels',
	Dimension: 'dimension',
	Zones: 'zones',
	Biomes: 'biomes',
	Index: 'index',
	Name: 'name',
	Levels: 'levels',
	Buckets: 'buckets',
	Group: 'group',
	Weight: 'weight',
	Resource: 'resource'
} as const;

// User-facing labels owned by the Terraforms Hypercastle page.
export const TERRAFORMS_HYPERCASTLE_LABELS = {
	All: 'all',
	AvailableBiomes: 'available biomes',
	Base: 'base',
	Band: 'band',
	Biome: 'biome',
	BiomeGroups: 'biome groups',
	BiomeWeights: 'biome weights',
	Biomes: 'biomes',
	Buckets: 'buckets',
	Catalog: 'catalog',
	Characters: 'characters',
	Elevation: 'elev',
	Grid: 'grid',
	Group: 'group',
	Hypercastle: 'Hypercastle',
	Index: 'index',
	Level: 'level',
	LevelFocus: 'level focus',
	LevelParcels: 'level parcels',
	Levels: 'levels',
	MaxGrid: 'max grid',
	MaxWeight: 'max weight',
	Name: 'name',
	Overview: 'overview',
	OverviewMaxGrid: '48x48',
	OverviewWidestLevels: 'L13 L14',
	Palette: 'palette',
	Parcels: 'parcels',
	SelectedBand: 'selected band',
	Threshold: 'threshold',
	Topography: 'topography',
	TopographyBands: 'topography bands',
	Weight: 'weight',
	Widest: 'widest',
	Zone: 'zone',
	ZoneSet: 'zone set',
	ZoneSets: 'zone sets',
	ZoneWindow: 'zone window',
	Zones: 'zones'
} as const;

// Locale used for compact integer formatting in the Terraforms Hypercastle page.
export const TERRAFORMS_HYPERCASTLE_NUMBER_FORMAT_LOCALE = 'en-US';

// Accessible region labels owned by the Terraforms Hypercastle page.
export const TERRAFORMS_HYPERCASTLE_ARIA_LABELS = {
	Catalog: 'Hypercastle catalog',
	CatalogTabs: 'Hypercastle catalog tabs',
	ContractTotals: 'Hypercastle contract totals',
	Focus: 'Hypercastle focus',
	GroupDrilldown: 'Hypercastle Zone-set drilldown',
	LevelIsometric: 'Hypercastle level isometric topography',
	LevelStack: 'Hypercastle level stack',
	TopographyBands: 'Hypercastle topography bands',
	LevelGroups: 'Hypercastle level groups',
	Levels: 'Hypercastle levels',
	Structure: 'Hypercastle structure'
} as const;

// Prefixes for compact Terraforms entity labels.
export const TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES = {
	Biome: 'B',
	BiomeGroup: 'G',
	Level: 'L',
	Zone: 'Z'
} as const;

// Local CSS class names applied to generated Terraforms isometric SVG nodes.
export const TERRAFORMS_HYPERCASTLE_ISOMETRIC_CLASSES = {
	Band: 'terraforms-hypercastle-isometric-band',
	BandSelected: 'terraforms-hypercastle-isometric-band-selected',
	Svg: 'terraforms-hypercastle-isometric-svg'
} as const;

// User-facing fallback text for the dynamically loaded isometric renderer.
export const TERRAFORMS_HYPERCASTLE_ISOMETRIC_RENDER_ERROR = 'isometric renderer unavailable';
