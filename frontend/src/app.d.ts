// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	const __APP_VERSION__: string;
	const __APP_COMMIT__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		interface PageData {
			collectionViewPage?: import('$lib/collection-view').CollectionViewPage | null;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
