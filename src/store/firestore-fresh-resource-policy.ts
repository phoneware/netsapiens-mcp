import { PRODUCTION_INVENTORY_BINDING } from '../cutover/writer-census-contract.mjs';

/** Resource identifiers here must come from the authenticated provider, not a locator. */
export interface FreshResourceIdentity {
  readonly projectId: string;
  readonly projectNumber: string;
  readonly databaseId: string;
  readonly databaseUid: string;
  readonly namespace: string;
}

/** A policy check, not evidence of provider creation or IAM isolation. */
export function assertFreshResourceAllowed(resource: FreshResourceIdentity): void {
  if (!resource || typeof resource.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(resource.projectId) ||
    typeof resource.projectNumber !== 'string' || !/^[1-9][0-9]*$/.test(resource.projectNumber) ||
    typeof resource.databaseId !== 'string' || resource.databaseId.length === 0 || resource.databaseId.includes('/') ||
    typeof resource.databaseUid !== 'string' || resource.databaseUid.length === 0 || resource.databaseUid.includes('/') ||
    typeof resource.namespace !== 'string' || resource.namespace.length === 0 || resource.namespace.includes('/')) {
    throw new Error('Invalid fresh Firestore resource identity');
  }
  if (resource.projectId === PRODUCTION_INVENTORY_BINDING.project ||
    resource.projectNumber === PRODUCTION_INVENTORY_BINDING.projectNumber) {
    throw new Error('Protected Firestore project cannot be used for fresh ownership');
  }
}
