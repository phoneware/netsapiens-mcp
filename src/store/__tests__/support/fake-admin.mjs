// Test-only fake of the Firestore Admin REST reads that readFirestoreAdminIndexes performs. It serves
// the signed index policy in the REST shapes the real API returns: field resources carry indexConfig,
// unset fields inherit the database default, and list calls answer the filters the reader sends. The
// protected code under test still reads, projects and digests what it is served. `mutate` lets a test
// serve a deliberately different observation (for example, absent or mismatched subject coverage).
// Bound to 127.0.0.1 only. The emulator fetch rewrites every Admin URL to this port.
import { createServer } from 'node:http';

function restIndex(fieldPath, mode) {
  const { queryScope, ...rest } = mode;
  return { queryScope, fields: [{ fieldPath, ...rest }] };
}

export async function startFakeAdmin({ databaseResource, policy, token = 'owner', mutate = (served) => served, port = 8081 }) {
  const served = mutate(structuredClone(policy));
  const defaultName = `${databaseResource}/collectionGroups/__default__/fields/*`;
  const prefix = `${databaseResource}/collectionGroups/`;

  const defaultResource = () => ({
    name: defaultName,
    indexConfig: { usesAncestorConfig: false, indexes: served.default.indexes.map((mode) => restIndex('*', mode)) },
  });

  const overrideFor = (group, fieldPath) => served.collections
    .find((entry) => entry.collectionGroup === group)?.overrides.find((entry) => entry.fieldPath === fieldPath);

  const fieldResource = (group, fieldPath) => {
    const name = `${databaseResource}/collectionGroups/${group}/fields/${fieldPath}`;
    const override = overrideFor(group, fieldPath);
    if (override) {
      return { name, indexConfig: { usesAncestorConfig: false, indexes: override.indexes.map((mode) => restIndex(fieldPath, mode)) } };
    }
    // An unset field inherits the database default, exactly as the Admin API reports it.
    return { name, indexConfig: { usesAncestorConfig: true, ancestorField: defaultName } };
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: { message: 'unauthenticated' } });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/v1/')) return send(res, 404, { error: { message: 'not found' } });
    const decoded = url.pathname.slice('/v1/'.length).split('/').map((segment) => decodeURIComponent(segment)).join('/');
    if (!decoded.startsWith(prefix)) return send(res, 404, { error: { message: 'not found' } });
    const tail = decoded.slice(prefix.length).split('/');
    const [group, kind, field] = tail;

    if (tail.length === 3 && kind === 'fields') {
      if (group === '__default__' && field === '*') return send(res, 200, defaultResource());
      if (!served.collections.some((entry) => entry.collectionGroup === group)) return send(res, 404, { error: { message: 'not found' } });
      return send(res, 200, fieldResource(group, field));
    }
    if (tail.length === 2 && kind === 'fields') {
      const filter = url.searchParams.get('filter');
      const entry = served.collections.find((item) => item.collectionGroup === group);
      if (!entry) return send(res, 404, { error: { message: 'not found' } });
      if (filter === 'indexConfig.usesAncestorConfig:false') {
        return send(res, 200, { fields: entry.overrides.map((override) => fieldResource(group, override.fieldPath)) });
      }
      // The TTL listing: no TTL is signed in this fixture, so none is served.
      return send(res, 200, { fields: [] });
    }
    if (tail.length === 2 && kind === 'indexes') return send(res, 200, { indexes: [] });
    return send(res, 404, { error: { message: 'not found' } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
