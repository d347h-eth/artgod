import {
	TERRAFORMS_BIOME_ATTRIBUTE_KEY,
	TERRAFORMS_BIOMES,
	TERRAFORMS_ZONE_ATTRIBUTE_KEY,
	TERRAFORMS_ZONES,
	type TerraformsBiome,
	type TerraformsZone
} from '@artgod/shared/extensions/terraforms';
import type { BidBookTraitDemandGroupPreviewProps } from '$lib/bid-book-trait-previews/types';
import {
	buildTerraformsBiomeCharacterLabels,
	resolveTerraformsBiomeDisplayCharacters
} from '$lib/collection-extension-pages/terraforms/biomes';
import { buildTerraformsZonePaletteSwatchLabels } from '$lib/collection-extension-pages/terraforms/level-zones';

type ValueOf<T> = T[keyof T];

export const TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS = {
	Zone: 'zone',
	Biome: 'biome',
	ZoneBiome: 'zone-biome'
} as const;

export type TerraformsBidBookTraitPreviewKind = ValueOf<
	typeof TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS
>;

export type TerraformsBidBookTraitPreviewModel =
	| {
			kind: typeof TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.Zone;
			zone: TerraformsZone;
			palette: readonly string[];
			paletteLabels: readonly string[];
	  }
	| {
			kind: typeof TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.Biome;
			biome: TerraformsBiome;
			characters: readonly string[];
			characterLabels: readonly string[];
			palette: null;
	  }
	| {
			kind: typeof TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.ZoneBiome;
			zone: TerraformsZone;
			biome: TerraformsBiome;
			characters: readonly string[];
			characterLabels: readonly string[];
			palette: readonly string[];
	  };

export const TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM = {
	testIds: {
		root: 'terraforms-bid-book-trait-preview'
	},
	classes: {
		root: 'terraforms-bid-book-trait-preview'
	}
} as const;

// Resolves the compact Terraforms preview that matches one trait-demand bucket.
export function resolveTerraformsBidBookTraitPreview(
	traits: BidBookTraitDemandGroupPreviewProps['traits']
): TerraformsBidBookTraitPreviewModel | null {
	const zone = resolveTerraformsTraitZone(traits);
	const biome = resolveTerraformsTraitBiome(traits);
	if (zone && biome) {
		const characters = resolveTerraformsBiomeDisplayCharacters(biome);
		return {
			kind: TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.ZoneBiome,
			zone,
			biome,
			characters,
			characterLabels: buildTerraformsBiomeCharacterLabels({
				biomeIndex: biome.index,
				characters
			}),
			palette: zone.palette
		};
	}
	if (zone) {
		return {
			kind: TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.Zone,
			zone,
			palette: zone.palette,
			paletteLabels: buildTerraformsZonePaletteSwatchLabels({
				zoneName: zone.name,
				palette: zone.palette
			})
		};
	}
	if (biome) {
		const characters = resolveTerraformsBiomeDisplayCharacters(biome);
		return {
			kind: TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.Biome,
			biome,
			characters,
			characterLabels: buildTerraformsBiomeCharacterLabels({
				biomeIndex: biome.index,
				characters
			}),
			palette: null
		};
	}
	return null;
}

function resolveTerraformsTraitZone(
	traits: BidBookTraitDemandGroupPreviewProps['traits']
): TerraformsZone | null {
	const zoneName = traits.find((trait) => trait.type === TERRAFORMS_ZONE_ATTRIBUTE_KEY)?.value;
	if (!zoneName) {
		return null;
	}
	return TERRAFORMS_ZONES.find((zone) => zone.name === zoneName) ?? null;
}

function resolveTerraformsTraitBiome(
	traits: BidBookTraitDemandGroupPreviewProps['traits']
): TerraformsBiome | null {
	const biomeValue = traits.find((trait) => trait.type === TERRAFORMS_BIOME_ATTRIBUTE_KEY)?.value;
	if (!biomeValue) {
		return null;
	}
	const biomeIndex = Number(biomeValue);
	if (!Number.isInteger(biomeIndex)) {
		return null;
	}
	return TERRAFORMS_BIOMES.find((biome) => biome.index === biomeIndex) ?? null;
}
