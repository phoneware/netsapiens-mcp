/**
 * When the suite runs against a Firestore emulator, start from an empty
 * database. Tests that persist counters (tool promotion, token stores) would
 * otherwise read the previous run's documents and fail on a reused emulator.
 */
export default async function setup(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) return;
  const project = process.env.GOOGLE_CLOUD_PROJECT || 'firestore-test';
  const url = `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Could not clear the Firestore emulator at ${host}: HTTP ${res.status}`);
  }
}
