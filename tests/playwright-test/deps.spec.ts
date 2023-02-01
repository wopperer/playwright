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

import { test, expect, stripAnsi } from './playwright-test-fixtures';

test('should run projects with dependencies', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = {
        projects: [
          { name: 'A' },
          { name: 'B', dependencies: ['A'] },
          { name: 'C', dependencies: ['A'] },
        ],
      };`,
    'test.spec.ts': `
      const { test } = pwt;
      test('test', async ({}, testInfo) => {
        console.log('\\n%%' + testInfo.project.name);
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(3);
  expect(extractLines(result.output)).toEqual(['A', 'B', 'C']);
});

test('should not run project if dependency failed', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = {
        projects: [
          { name: 'A' },
          { name: 'B', dependencies: ['A'] },
          { name: 'C', dependencies: ['B'] },
        ],
      };`,
    'test.spec.ts': `
      const { test } = pwt;
      test('test', async ({}, testInfo) => {
        console.log('\\n%%' + testInfo.project.name);
        if (testInfo.project.name === 'B')
          throw new Error('Failed project B');
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.skipped).toBe(1);
  expect(result.output).toContain('Failed project B');
  expect(extractLines(result.output)).toEqual(['A', 'B']);
});

test('should not run project if dependency failed (2)', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = {
        projects: [
          { name: 'A1' },
          { name: 'A2', dependencies: ['A1'] },
          { name: 'A3', dependencies: ['A2'] },
          { name: 'B1' },
          { name: 'B2', dependencies: ['B1'] },
          { name: 'B3', dependencies: ['B2'] },
        ],
      };`,
    'test.spec.ts': `
      const { test } = pwt;
      test('test', async ({}, testInfo) => {
        console.log('\\n%%' + testInfo.project.name);
        if (testInfo.project.name === 'B1')
          throw new Error('Failed project B1');
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(1);
  expect(extractLines(result.output).sort()).toEqual(['A1', 'A2', 'A3', 'B1']);
});

test('should filter by project list, but run deps', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { projects: [
        { name: 'A' },
        { name: 'B' },
        { name: 'C', dependencies: ['A'] },
        { name: 'D' },
      ] };
    `,
    'test.spec.ts': `
      const { test } = pwt;
      test('pass', async ({}, testInfo) => {
        console.log('\\n%%' + testInfo.project.name);
      });
    `
  }, { project: ['C', 'D'] });
  expect(result.passed).toBe(3);
  expect(result.failed).toBe(0);
  expect(result.skipped).toBe(0);
  expect(extractLines(result.output).sort()).toEqual(['A', 'C', 'D']);
});


test('should not filter dependency by file name', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { projects: [
        { name: 'A' },
        { name: 'B', dependencies: ['A'] },
      ] };
    `,
    'one.spec.ts': `pwt.test('fails', () => { expect(1).toBe(2); });`,
    'two.spec.ts': `pwt.test('pass', () => { });`,
  }, undefined, undefined, { additionalArgs: ['two.spec.ts'] });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.output).toContain('1) [A] › one.spec.ts:4:5 › fails');
});

test('should not filter dependency by only', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { projects: [
        { name: 'setup', testMatch: /setup.ts/ },
        { name: 'browser', dependencies: ['setup'] },
      ] };
    `,
    'setup.ts': `
      pwt.test('passes', () => {
        console.log('\\n%% setup in ' + pwt.test.info().project.name);
      });
      pwt.test.only('passes 2', () => {
        console.log('\\n%% setup 2 in ' + pwt.test.info().project.name);
      });
    `,
    'test.spec.ts': `pwt.test('pass', () => {
      console.log('\\n%% test in ' + pwt.test.info().project.name);
    });`,
  });
  expect(result.exitCode).toBe(0);
  expect(extractLines(result.output)).toEqual(['setup in setup', 'setup 2 in setup', 'test in browser']);
});

test('should not filter dependency by only 2', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { projects: [
        { name: 'setup', testMatch: /setup.ts/ },
        { name: 'browser', dependencies: ['setup'] },
      ] };
    `,
    'setup.ts': `
      pwt.test('passes', () => {
        console.log('\\n%% setup in ' + pwt.test.info().project.name);
      });
      pwt.test.only('passes 2', () => {
        console.log('\\n%% setup 2 in ' + pwt.test.info().project.name);
      });
    `,
    'test.spec.ts': `pwt.test('pass', () => {
      console.log('\\n%% test in ' + pwt.test.info().project.name);
    });`,
  }, { project: ['setup'] });
  expect(result.exitCode).toBe(0);
  expect(extractLines(result.output)).toEqual(['setup 2 in setup']);
});

test('should not filter dependency by only 3', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { projects: [
        { name: 'setup', testMatch: /setup.*.ts/ },
        { name: 'browser', dependencies: ['setup'] },
      ] };
    `,
    'setup-1.ts': `
      pwt.test('setup 1', () => {
        console.log('\\n%% setup in ' + pwt.test.info().project.name);
      });
    `,
    'setup-2.ts': `
      pwt.test('setup 2', () => {
        console.log('\\n%% setup 2 in ' + pwt.test.info().project.name);
      });
    `,
    'test.spec.ts': `pwt.test('pass', () => {
      console.log('\\n%% test in ' + pwt.test.info().project.name);
    });`,
  }, undefined, undefined, { additionalArgs: ['setup-2.ts'] });
  expect(result.exitCode).toBe(0);
  expect(extractLines(result.output)).toEqual(['setup 2 in setup']);
});

test('should report skipped dependent tests', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { projects: [
        { name: 'setup', testMatch: /setup.ts/ },
        { name: 'browser', dependencies: ['setup'] },
      ] };
    `,
    'setup.ts': `
      pwt.test('setup', () => {
        expect(1).toBe(2);
      });
    `,
    'test.spec.ts': `pwt.test('pass', () => {});`,
  });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.results.length).toBe(2);
});

test('should report circular dependencies', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      module.exports = { projects: [
        { name: 'A', dependencies: ['B'] },
        { name: 'B', dependencies: ['A'] },
      ] };
    `,
    'test.spec.ts': `pwt.test('pass', () => {});`,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Circular dependency detected between projects.');
});

function extractLines(output: string): string[] {
  return stripAnsi(output).split('\n').filter(line => line.startsWith('%%')).map(line => line.substring(2).trim());
}
