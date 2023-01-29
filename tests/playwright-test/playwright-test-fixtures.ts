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

import type { JSONReport, JSONReportSuite, JSONReportTest, JSONReportTestResult } from '@playwright/test/reporter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rimraf, PNG } from 'playwright-core/lib/utilsBundle';
import { promisify } from 'util';
import type { CommonFixtures } from '../config/commonFixtures';
import { commonFixtures } from '../config/commonFixtures';
import type { ServerFixtures, ServerWorkerOptions } from '../config/serverFixtures';
import { serverFixtures } from '../config/serverFixtures';
import type { TestInfo } from './stable-test-runner';
import { expect } from './stable-test-runner';
import { test as base } from './stable-test-runner';

const removeFolderAsync = promisify(rimraf);

export type CliRunResult = {
  exitCode: number,
  output: string,
};

export type RunResult = {
  exitCode: number,
  output: string,
  passed: number,
  failed: number,
  flaky: number,
  skipped: number,
  interrupted: number,
  report: JSONReport,
  results: any[],
};

type TSCResult = {
  output: string;
  exitCode: number;
};

type Files = { [key: string]: string | Buffer };
type Params = { [key: string]: string | number | boolean | string[] };
type Env = { [key: string]: string | number | boolean | undefined };

async function writeFiles(testInfo: TestInfo, files: Files) {
  const baseDir = testInfo.outputPath();

  const headerJS = `
    const pwt = require('@playwright/test');
  `;
  const headerTS = `
    import * as pwt from '@playwright/test';
  `;
  const headerESM = `
    import * as pwt from '@playwright/test';
  `;

  const hasConfig = Object.keys(files).some(name => name.includes('.config.'));
  if (!hasConfig) {
    files = {
      ...files,
      'playwright.config.ts': `
        module.exports = { projects: [ {} ] };
      `,
    };
  }
  if (!Object.keys(files).some(name => name.includes('package.json'))) {
    files = {
      ...files,
      'package.json': `{ "name": "test-project" }`,
    };
  }

  await Promise.all(Object.keys(files).map(async name => {
    const fullName = path.join(baseDir, name);
    await fs.promises.mkdir(path.dirname(fullName), { recursive: true });
    const isTypeScriptSourceFile = name.endsWith('.ts') && !name.endsWith('.d.ts');
    const isJSModule = name.endsWith('.mjs') || name.includes('esm');
    const header = isTypeScriptSourceFile ? headerTS : (isJSModule ? headerESM : headerJS);
    if (typeof files[name] === 'string' && files[name].includes('//@no-header')) {
      await fs.promises.writeFile(fullName, files[name]);
    } else if (/(spec|test)\.(js|ts|jsx|tsx|mjs)$/.test(name)) {
      const fileHeader = header + 'const { expect } = pwt;\n';
      await fs.promises.writeFile(fullName, fileHeader + files[name]);
    } else if (/\.(js|ts)$/.test(name) && !name.endsWith('d.ts')) {
      await fs.promises.writeFile(fullName, header + files[name]);
    } else {
      await fs.promises.writeFile(fullName, files[name]);
    }
  }));

  return baseDir;
}

const cliEntrypoint = path.join(__dirname, '../../packages/playwright-core/cli.js');

async function runPlaywrightTest(childProcess: CommonFixtures['childProcess'], baseDir: string, params: any, env: Env, options: RunOptions): Promise<RunResult> {
  const paramList: string[] = [];
  for (const key of Object.keys(params)) {
    for (const value of Array.isArray(params[key]) ? params[key] : [params[key]]) {
      const k = key.startsWith('-') ? key : '--' + key;
      paramList.push(params[key] === true ? `${k}` : `${k}=${value}`);
    }
  }
  const outputDir = path.join(baseDir, 'test-results');
  const reportFile = path.join(outputDir, 'report.json');
  const args = ['test'];
  if (!options.usesCustomOutputDir)
    args.push('--output=' + outputDir);
  if (!options.usesCustomReporters)
    args.push('--reporter=dot,json');
  args.push(
      '--workers=2',
      ...paramList
  );
  if (options.additionalArgs)
    args.push(...options.additionalArgs);

  const cwd = options.cwd ? path.resolve(baseDir, options.cwd) : baseDir;
  // eslint-disable-next-line prefer-const
  let { exitCode, output } = await runPlaywrightCommand(childProcess, cwd, args, {
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
    ...env,
  }, options.sendSIGINTAfter);

  const summary = (re: RegExp) => {
    let result = 0;
    let match = re.exec(output);
    while (match) {
      result += (+match[1]);
      match = re.exec(output);
    }
    return result;
  };
  const passed = summary(/(\d+) passed/g);
  const failed = summary(/(\d+) failed/g);
  const flaky = summary(/(\d+) flaky/g);
  const skipped = summary(/(\d+) skipped/g);
  const interrupted = summary(/(\d+) interrupted/g);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile).toString());
  } catch (e) {
    output += '\n' + e.toString();
  }

  const results: JSONReportTestResult[] = [];
  function visitSuites(suites?: JSONReportSuite[]) {
    if (!suites)
      return;
    for (const suite of suites) {
      for (const spec of suite.specs) {
        for (const test of spec.tests)
          results.push(...test.results);
      }
      visitSuites(suite.suites);
    }
  }
  if (report)
    visitSuites(report.suites);

  return {
    exitCode,
    output,
    passed,
    failed,
    flaky,
    skipped,
    interrupted,
    report,
    results,
  };
}

async function runPlaywrightCommand(childProcess: CommonFixtures['childProcess'], cwd: string, commandWithArguments: string[], env: Env, sendSIGINTAfter?: number): Promise<CliRunResult> {
  const command = ['node', cliEntrypoint];
  command.push(...commandWithArguments);
  const cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'playwright-test-cache-'));
  const testProcess = childProcess({
    command,
    env: {
      ...process.env,
      PWTEST_CACHE_DIR: cacheDir,
      // BEGIN: Reserved CI
      CI: undefined,
      BUILD_URL: undefined,
      CI_COMMIT_SHA: undefined,
      CI_JOB_URL: undefined,
      CI_PROJECT_URL: undefined,
      GITHUB_REPOSITORY: undefined,
      GITHUB_RUN_ID: undefined,
      GITHUB_SERVER_URL: undefined,
      GITHUB_SHA: undefined,
      // END: Reserved CI
      PW_TEST_HTML_REPORT_OPEN: undefined,
      PW_TEST_REPORTER: undefined,
      PW_TEST_REPORTER_WS_ENDPOINT: undefined,
      PW_TEST_SOURCE_TRANSFORM: undefined,
      PW_TEST_SOURCE_TRANSFORM_SCOPE: undefined,
      TEST_WORKER_INDEX: undefined,
      TEST_PARLLEL_INDEX: undefined,
      NODE_OPTIONS: undefined,
      ...env,
    },
    cwd,
  });
  let didSendSigint = false;
  testProcess.onOutput = () => {
    if (sendSIGINTAfter && !didSendSigint && countTimes(testProcess.output, '%%SEND-SIGINT%%') >= sendSIGINTAfter) {
      didSendSigint = true;
      process.kill(testProcess.process.pid!, 'SIGINT');
    }
  };
  const { exitCode } = await testProcess.exited;
  await removeFolderAsync(cacheDir);

  return { exitCode, output: testProcess.output.toString() };
}


type RunOptions = {
  sendSIGINTAfter?: number;
  usesCustomOutputDir?: boolean;
  usesCustomReporters?: boolean;
  additionalArgs?: string[];
  cwd?: string,
};
type Fixtures = {
  writeFiles: (files: Files) => Promise<string>;
  runInlineTest: (files: Files, params?: Params, env?: Env, options?: RunOptions, beforeRunPlaywrightTest?: ({ baseDir }: { baseDir: string }) => Promise<void>) => Promise<RunResult>;
  runTSC: (files: Files) => Promise<TSCResult>;
  nodeVersion: { major: number, minor: number, patch: number };
  runGroups: (files: Files, params?: Params, env?: Env, options?: RunOptions) => Promise<{ timeline: { titlePath: string[], event: 'begin' | 'end' }[] } & RunResult>;
  runCommand: (files: Files, args: string[]) => Promise<CliRunResult>;
};

export const test = base
    .extend<CommonFixtures>(commonFixtures)
    .extend<ServerFixtures, ServerWorkerOptions>(serverFixtures)
    .extend<Fixtures>({
      writeFiles: async ({}, use, testInfo) => {
        await use(files => writeFiles(testInfo, files));
      },

      runInlineTest: async ({ childProcess }, use, testInfo: TestInfo) => {
        await use(async (files: Files, params: Params = {}, env: Env = {}, options: RunOptions = {}, beforeRunPlaywrightTest?: ({ baseDir: string }) => Promise<void>) => {
          const baseDir = await writeFiles(testInfo, files);
          if (beforeRunPlaywrightTest)
            await beforeRunPlaywrightTest({ baseDir });
          return await runPlaywrightTest(childProcess, baseDir, params, env, options);
        });
      },

      runCommand: async ({ childProcess }, use, testInfo: TestInfo) => {
        await use(async (files: Files, args: string[]) => {
          const baseDir = await writeFiles(testInfo, files);
          return await runPlaywrightCommand(childProcess, baseDir, args, { });
        });
      },

      runTSC: async ({ childProcess }, use, testInfo) => {
        await use(async files => {
          const baseDir = await writeFiles(testInfo, { 'tsconfig.json': JSON.stringify(TSCONFIG), ...files });
          const tsc = childProcess({
            command: ['npx', 'tsc', '-p', baseDir],
            cwd: baseDir,
            shell: true,
          });
          const { exitCode } = await tsc.exited;
          return { exitCode, output: tsc.output };
        });
      },

      nodeVersion: async ({}, use) => {
        const [major, minor, patch] = process.versions.node.split('.');
        await use({ major: +major, minor: +minor, patch: +patch });
      },

      runGroups: async ({ runInlineTest }, use, testInfo) => {
        const timelinePath = testInfo.outputPath('timeline.json');
        await use(async (files, params, env, options) => {
          const result = await runInlineTest({
            ...files,
            'reporter.ts': `
              import { Reporter, TestCase } from '@playwright/test/reporter';
              import fs from 'fs';
              import path from 'path';
              class TimelineReporter implements Reporter {
                private _timeline: {titlePath: string, event: 'begin' | 'end'}[] = [];
                onTestBegin(test: TestCase) {
                  this._timeline.push({ titlePath: test.titlePath(), event: 'begin' });
                }
                onTestEnd(test: TestCase) {
                  this._timeline.push({ titlePath: test.titlePath(), event: 'end' });
                }
                onEnd() {
                  fs.writeFileSync(path.join(${JSON.stringify(timelinePath)}), JSON.stringify(this._timeline, null, 2));
                }
              }
              export default TimelineReporter;
            `
          }, { ...params, reporter: 'list,json,./reporter.ts', workers: 2 }, env, options);

          let timeline;
          try {
            timeline = JSON.parse((await fs.promises.readFile(timelinePath, 'utf8')).toString());
          } catch (e) {
          }
          return {
            ...result,
            timeline
          };
        });
      },
    });

const TSCONFIG = {
  'compilerOptions': {
    'target': 'ESNext',
    'moduleResolution': 'node',
    'module': 'commonjs',
    'strict': true,
    'esModuleInterop': true,
    'allowSyntheticDefaultImports': true,
    'rootDir': '.',
    'lib': ['esnext', 'dom', 'DOM.Iterable'],
    'noEmit': true,
  },
  'exclude': [
    'node_modules'
  ]
};

export { expect } from './stable-test-runner';

const asciiRegex = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');
export function stripAnsi(str: string): string {
  return str.replace(asciiRegex, '');
}

export function countTimes(s: string, sub: string): number {
  let result = 0;
  for (let index = 0; index !== -1;) {
    index = s.indexOf(sub, index);
    if (index !== -1) {
      result++;
      index += sub.length;
    }
  }
  return result;
}

export function createImage(width: number, height: number, r: number = 0, g: number = 0, b: number = 0, a: number = 255): Buffer {
  const image = new PNG({ width, height });
  // Make both images red.
  for (let i = 0; i < width * height; ++i) {
    image.data[i * 4 + 0] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = a;
  }
  return PNG.sync.write(image);
}

export function createWhiteImage(width: number, height: number) {
  return createImage(width, height, 255, 255, 255);
}

export function paintBlackPixels(image: Buffer, blackPixelsCount: number): Buffer {
  const png = PNG.sync.read(image);
  for (let i = 0; i < blackPixelsCount; ++i) {
    for (let j = 0; j < 3; ++j)
      png.data[i * 4 + j] = 0;
  }
  return PNG.sync.write(png);
}

export function allTests(result: RunResult) {
  const tests: { title: string; expectedStatus: JSONReportTest['expectedStatus'], actualStatus: JSONReportTest['status'], annotations: string[] }[] = [];
  const visit = (suite: JSONReportSuite) => {
    for (const spec of suite.specs)
      spec.tests.forEach(t => tests.push({ title: spec.title, expectedStatus: t.expectedStatus, actualStatus: t.status, annotations: t.annotations.map(a => a.type)  }));
    suite.suites?.forEach(s => visit(s));
  };
  visit(result.report.suites[0]);
  return tests;
}

export function expectTestHelper(result: RunResult) {
  return (title: string, expectedStatus: string, status: string, annotations: any) => {
    const tests = allTests(result).filter(t => t.title === title);
    for (const test of tests) {
      expect(test.expectedStatus, `title: ${title}`).toBe(expectedStatus);
      expect(test.actualStatus, `title: ${title}`).toBe(status);
      expect(test.annotations, `title: ${title}`).toEqual(annotations);
    }
  };
}
