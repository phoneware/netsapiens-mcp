import type { Firestore } from '@google-cloud/firestore';
import type { FirestoreLike } from '../firestore.js';

type Assert<T extends true> = T;
type InstalledSdkFits = Assert<Firestore extends FirestoreLike ? true : false>;
export type { InstalledSdkFits };
