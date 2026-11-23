import { TRAIT_NODE_KIND, type TraitNode } from '@artgod/shared/types/trait-catalog';
import type { TraitFilter } from '@artgod/shared/types/browse';

// Flat traits retain their counts, links and bidding actions in the detail table.
export function detailTraitTree(
	tree: readonly TraitNode[],
	flat: readonly TraitFilter[]
): TraitNode[] {
	const visible = new Set(flat.map((trait) => JSON.stringify([trait.key, trait.value])));
	function remaining(nodes: readonly TraitNode[]): TraitNode[] {
		const result: TraitNode[] = [];
		for (const node of nodes) {
			if (node.kind === TRAIT_NODE_KIND.Leaf) {
				if (!visible.has(JSON.stringify([node.fieldId, node.value]))) result.push(node);
			} else {
				const children = remaining(node.children);
				if (children.length) result.push({ ...node, children });
			}
		}
		return result;
	}
	return remaining(tree);
}
