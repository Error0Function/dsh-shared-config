import type { Document } from 'yaml';
/** Parse a persisted patch list, refusing malformed documents. */
export declare function patchDocument(raw: string): Document;
/** Replace or remove one entry config without deleting its other metadata. */
export declare function editPatch(raw: string, id: string, name: string, config: Record<string, unknown> | undefined): string;
