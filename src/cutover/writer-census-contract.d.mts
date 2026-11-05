export interface InventoryBinding {
  readonly profile: 'production' | 'emulator';
  readonly project: string;
  readonly projectNumber: string | null;
  readonly database: string;
}
export const PRODUCTION_INVENTORY_BINDING: Readonly<InventoryBinding>;
export const EMULATOR_INVENTORY_BINDING: Readonly<InventoryBinding>;
export function compareCensus(input: { census: unknown; observed: unknown; measurements: unknown; surfaces: unknown; scopeGroups: unknown; binding: InventoryBinding }): { decision: 'match' | 'fail' };
