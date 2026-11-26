import { TRAIT_NODE_KIND, type TraitNode } from '@artgod/shared/types/trait-catalog';
import type { TraitFilter } from '@artgod/shared/types/browse';

export type TraitLeaf = Extract<TraitNode, { kind: typeof TRAIT_NODE_KIND.Leaf }>;

// A structured node is filterable only if its field and value appear in the flat catalog.
function indexFlatTraits(traits: readonly TraitFilter[]) {
	const fields = new Map(traits.map((trait) => [JSON.stringify([trait.key, trait.value]), trait]));
	return (leaf: TraitLeaf) => fields.get(JSON.stringify([leaf.fieldId, leaf.value]));
}

// Flat traits retain their counts, links and bidding actions in the detail table.
export function detailTraitTree(
	tree: readonly TraitNode[],
	flat: readonly TraitFilter[]
): TraitNode[] {
	const flatTrait = indexFlatTraits(flat);
	function remaining(nodes: readonly TraitNode[]): TraitNode[] {
		const result: TraitNode[] = [];
		for (const node of nodes) {
			if (node.kind === TRAIT_NODE_KIND.Leaf) {
				if (!flatTrait(node)) result.push(node);
			} else {
				const children = remaining(node.children);
				if (children.length) result.push({ ...node, children });
			}
		}
		return result;
	}
	return remaining(tree);
}
