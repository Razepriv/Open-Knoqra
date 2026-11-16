import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkEditions, reachesPro, specifiersOf } from './check-editions.mjs';

describe('check-editions', () => {
  it('finds static, dynamic and side-effect specifiers', () => {
    const text = `import a from './a';\nexport * from "../b";\nimport './c';\nawait import('./d');\nrequire('e');`;
    assert.deepEqual(specifiersOf(text).sort(), ['../b', './a', './c', './d', 'e']);
  });

  it('flags relative paths into pro/ and private package subpaths', () => {
    assert.equal(reachesPro('apps/api/src/app.ts', '../pro/src/extension'), true);
    assert.equal(reachesPro('apps/web/src/lib/x.ts', '../../pro/lib/billing'), true);
    assert.equal(reachesPro('apps/api/src/app.ts', './lib/pricing'), false);
    assert.equal(reachesPro('apps/web/src/x.ts', '@knoqra/core/pro'), true);
    assert.equal(reachesPro('apps/web/src/x.ts', '@knoqra/api-client/pro/schema'), true);
    assert.equal(reachesPro('apps/web/src/x.ts', '@knoqra/core'), false);
    assert.equal(reachesPro('apps/web/src/x.ts', 'product-list'), false);
  });

  it('lets pro/ import core, and asks every pro/ folder for a LICENSE', () => {
    const files = {
      'apps/api/src/app.ts': "import { x } from './x';",
      'apps/api/pro/src/a.ts': "import { app } from '../../src/app';",
      'packages/db/pro/index.ts': "export * from './schema';",
      'packages/db/pro/LICENSE': 'Proprietary',
    };
    const errors = checkEditions(
      Object.keys(files),
      (f) => files[f],
      (f) => f in files,
    );
    assert.deepEqual(errors, ['apps/api/pro: a pro/ folder needs its own LICENSE']);
  });

  it('reports a core file that imports Pro code', () => {
    const files = { 'apps/web/src/a.tsx': "import { B } from '../pro/b';" };
    const errors = checkEditions(
      Object.keys(files),
      (f) => files[f],
      () => true,
    );
    assert.deepEqual(errors, ['apps/web/src/a.tsx: imports Pro code (../pro/b)']);
  });
});
