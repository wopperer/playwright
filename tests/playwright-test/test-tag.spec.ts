/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './playwright-test-fixtures';

test('should have correct tags', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': `
      export default class Reporter {
        onBegin(config, suite) {
          const visit = suite => {
            for (const test of suite.tests || [])
              console.log('\\n%%title=' + test.title + ', tags=' + test.tags.join(','));
            for (const child of suite.suites || [])
              visit(child);
          };
          visit(suite);
        }
        onError(error) {
          console.log(error);
        }
      }
    `,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'stdio.spec.js': `
      import { test, expect } from '@playwright/test';
      test('no-tags', () => {
        expect(test.info()._test.tags).toEqual([]);
      });
      test('foo-tag', { tag: '@foo' }, () => {
        expect(test.info()._test.tags).toEqual(['@foo']);
      });
      test('foo-bar-tags', { tag: ['@foo', '@bar'] }, () => {
        expect(test.info()._test.tags).toEqual(['@foo', '@bar']);
      });
      test.skip('skip-foo-tag', { tag: '@foo' }, () => {
      });
      test.fixme('fixme-bar-tag', { tag: '@bar' }, () => {
      });
      test.fail('fail-foo-bar-tags', { tag: ['@foo', '@bar'] }, () => {
        expect(1).toBe(2);
      });
      test.describe('suite', { tag: '@foo' }, () => {
        test('foo-suite', () => {
          expect(test.info()._test.tags).toEqual(['@foo']);
        });
        test.describe('inner', { tag: '@bar' }, () => {
          test('foo-bar-suite', () => {
            expect(test.info()._test.tags).toEqual(['@foo', '@bar']);
          });
        });
      });
      test.describe.skip('skip-foo-suite', { tag: '@foo' }, () => {
        test('skip-foo-suite', () => {
        });
      });
      test.describe.fixme('fixme-bar-suite', { tag: '@bar' }, () => {
        test('fixme-bar-suite', () => {
        });
      });
    `
  });
  expect(result.exitCode).toBe(0);
  expect(result.outputLines).toEqual([
    `title=no-tags, tags=`,
    `title=foo-tag, tags=@foo`,
    `title=foo-bar-tags, tags=@foo,@bar`,
    `title=skip-foo-tag, tags=@foo`,
    `title=fixme-bar-tag, tags=@bar`,
    `title=fail-foo-bar-tags, tags=@foo,@bar`,
    `title=foo-suite, tags=@foo`,
    `title=foo-bar-suite, tags=@foo,@bar`,
    `title=skip-foo-suite, tags=@foo`,
    `title=fixme-bar-suite, tags=@bar`,
  ]);
});

test('config.tagFilter should work', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { tagFilter: '@tag1' };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: '@tag1' }, async () => { console.log('\\n%% test1'); });
      test('test2', async () => { console.log('\\n%% test2'); });
    `,
  });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(1);
  expect(result.outputLines).toEqual(['test1']);
});

test('config.project.tag should work', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { projects: [
        { name: 'p1' },
        { name: 'p2', tagFilter: '@tag1' }
      ] };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: '@tag1' }, async () => { console.log('\\n%% test1-' + test.info().project.name); });
      test('test2', async () => { console.log('\\n%% test2-' + test.info().project.name); });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(3);
  expect(result.outputLines).toEqual(['test1-p1', 'test2-p1', 'test1-p2']);
});

test('--tag should work', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: '@tag1' }, async () => { console.log('\\n%% test1'); });
      test('test2', async () => { console.log('\\n%% test2'); });
    `,
  }, { tag: '@tag1' });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(1);
  expect(result.outputLines).toEqual(['test1']);
});

test('should parse tag expressions', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = {
        projects: [
          { name: 'p1', tagFilter: '@foo' },
          { name: 'p2', tagFilter: 'not @foo' },
          { name: 'p3', tagFilter: '    @foo and @bar' },
          { name: 'p4', tagFilter: '@bar or not @foo' },
          { name: 'p5', tagFilter: '@bar and (@foo or not @foo)' },
          { name: 'p6', tagFilter: '@qux or @foo and @bar' },
          { name: 'p7', tagFilter: '@qux and (@foo or @bar)' },
          { name: 'p8', tagFilter: 'not not not @foo' },
        ]
      };
    `,
    'stdio.spec.js': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: '@foo' }, () => {
        console.log('\\n%% foo-' + test.info().project.name);
      });
      test('test2', { tag: '@bar' }, () => {
        console.log('\\n%% bar-' + test.info().project.name);
      });
      test('test3', { tag: ['@foo', '@bar'] }, () => {
        console.log('\\n%% foobar-' + test.info().project.name);
      });
    `
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.outputLines).toEqual([
    `foo-p1`,
    `foobar-p1`,
    `bar-p2`,
    `foobar-p3`,
    `bar-p4`,
    `foobar-p4`,
    `bar-p5`,
    `foobar-p5`,
    `foobar-p6`,
    `bar-p8`,
  ]);
});

test('should enforce @ symbol', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'stdio.spec.js': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: 'foo' }, () => {
      });
    `
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`Error: Tag must start with "@" symbol, got "foo" instead.`);
});

test('should report tag expression error 1', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'stdio.spec.js': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: '@foo' }, () => {
      });
    `
  }, { tag: '(@foo' });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`Error: Expected matching ")" when parsing tag expression: (@foo`);
});

test('should report tag expression error 2', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'stdio.spec.js': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: '@foo' }, () => {
      });
    `
  }, { tag: '(@foo)@bar' });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`Error: Unexpected extra tokens in the tag expression: (@foo)@bar`);
});

test('should report tag expression error 3', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'stdio.spec.js': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: '@foo' }, () => {
      });
    `
  }, { tag: '@foo and' });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`Error: Unexpected end of tag expression: @foo and`);
});

test('should report tag expression error 4', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'stdio.spec.js': `
      import { test, expect } from '@playwright/test';
      test('test1', { tag: '@foo' }, () => {
      });
    `
  }, { tag: '@foo @bar' });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`Error: Unexpected extra tokens in the tag expression: @foo @bar`);
});
