import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const [certificatePath, keyPath] = process.argv.slice(2);
if (!certificatePath || !keyPath) {
  throw new Error('Usage: node tools/knowledge-source-fixture.mjs <certificate> <key>');
}

const documents = {
  alpha1: Buffer.from('# 差旅制度\n\n国内差旅住宿标准为每晚 600 元。\n', 'utf8'),
  alpha2: Buffer.from('# 差旅制度\n\n国内差旅住宿标准调整为每晚 680 元。\n', 'utf8'),
  beta1: Buffer.from('# 远程办公\n\n员工每周可申请两天远程办公。\n', 'utf8'),
  gamma1: Buffer.from('# 采购流程\n\n超过 5 万元的采购须由财务负责人复核。\n', 'utf8'),
};
let phase = 1;

const server = createServer(
  {
    cert: readFileSync(certificatePath),
    key: readFileSync(keyPath),
  },
  (request, response) => {
    const url = new URL(request.url ?? '/', 'https://localhost:9443');
    if (request.method === 'POST' && url.pathname === '/advance') {
      phase = 2;
      sendJson(response, { phase });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      sendJson(response, { phase });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/manifest') {
      sendJson(response, manifest(url.searchParams.get('cursor')));
      return;
    }
    const documentKey = /^\/files\/(alpha-v1|alpha-v2|beta-v1|gamma-v1)\.md$/u.exec(
      url.pathname,
    )?.[1];
    if (request.method === 'GET' && documentKey) {
      const keyByPath = {
        'alpha-v1': 'alpha1',
        'alpha-v2': 'alpha2',
        'beta-v1': 'beta1',
        'gamma-v1': 'gamma1',
      };
      const body = documents[keyByPath[documentKey]];
      response.writeHead(200, {
        'content-type': 'text/markdown',
        'content-length': body.byteLength,
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  },
);

server.listen(9443, '127.0.0.1', () => {
  process.stdout.write('knowledge-source-fixture listening on https://localhost:9443\n');
});

function manifest(cursor) {
  if (phase === 1 && cursor === null) {
    return {
      schemaVersion: 1,
      nextCursor: 'fixture-phase-1',
      hasMore: false,
      items: [
        item('travel-policy', '差旅制度', 'alpha-v1.md', 'v1', documents.alpha1),
        item('remote-work', '远程办公制度', 'beta-v1.md', 'v1', documents.beta1),
      ],
    };
  }
  if (phase === 2 && cursor === 'fixture-phase-1') {
    return {
      schemaVersion: 1,
      nextCursor: 'fixture-phase-2',
      hasMore: false,
      items: [
        item('travel-policy', '差旅制度', 'alpha-v2.md', 'v2', documents.alpha2),
        {
          externalId: 'remote-work',
          title: '远程办公制度',
          fileName: 'beta-v1.md',
          mimeType: 'text/markdown',
          downloadUrl: null,
          sourceUri: 'https://localhost:9443/source/remote-work',
          sourceRevision: 'deleted-v2',
          sha256: null,
          modifiedAt: '2026-08-05T12:30:00.000Z',
          deleted: true,
        },
        item('purchase-process', '采购流程', 'gamma-v1.md', 'v1', documents.gamma1),
      ],
    };
  }
  return {
    schemaVersion: 1,
    nextCursor: cursor ?? `fixture-phase-${phase}`,
    hasMore: false,
    items: [],
  };
}

function item(externalId, title, fileName, sourceRevision, body) {
  const pathName = fileName.replace('.md', '');
  return {
    externalId,
    title,
    fileName,
    mimeType: 'text/markdown',
    downloadUrl: `https://localhost:9443/files/${pathName}.md`,
    sourceUri: `https://localhost:9443/source/${externalId}`,
    sourceRevision,
    sha256: createHash('sha256').update(body).digest('hex'),
    modifiedAt: phase === 1 ? '2026-08-05T12:00:00.000Z' : '2026-08-05T12:30:00.000Z',
    deleted: false,
  };
}

function sendJson(response, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  response.end(body);
}
