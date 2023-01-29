/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';
import type { TestError } from '../../reporter';
import type { LoadError } from './fixtures';
import { setCurrentlyLoadingFileSuite } from './globals';
import { PoolBuilder } from './poolBuilder';
import { Suite } from './test';
import { requireOrImport } from './transform';
import { serializeError } from '../util';

export const defaultTimeout = 30000;

// To allow multiple loaders in the same process without clearing require cache,
// we make these maps global.
const cachedFileSuites = new Map<string, Suite>();

export class TestLoader {
  private _rootDir: string;

  constructor(rootDir: string) {
    this._rootDir = rootDir;
  }

  async loadTestFile(file: string, environment: 'loader' | 'worker', loadErrors: TestError[]): Promise<Suite> {
    if (cachedFileSuites.has(file))
      return cachedFileSuites.get(file)!;
    const suite = new Suite(path.relative(this._rootDir, file) || path.basename(file), 'file');
    suite._requireFile = file;
    suite.location = { file, line: 0, column: 0 };

    setCurrentlyLoadingFileSuite(suite);
    try {
      await requireOrImport(file);
      cachedFileSuites.set(file, suite);
    } catch (e) {
      if (environment === 'worker')
        throw e;
      loadErrors.push(serializeError(e));
    } finally {
      setCurrentlyLoadingFileSuite(undefined);
    }

    {
      // Test locations that we discover potentially have different file name.
      // This could be due to either
      //   a) use of source maps or due to
      //   b) require of one file from another.
      // Try fixing (a) w/o regressing (b).

      const files = new Set<string>();
      suite.allTests().map(t => files.add(t.location.file));
      if (files.size === 1) {
        // All tests point to one file.
        const mappedFile = files.values().next().value;
        if (suite.location.file !== mappedFile) {
          // The file is different, check for a likely source map case.
          if (path.extname(mappedFile) !== path.extname(suite.location.file))
            suite.location.file = mappedFile;
        }
      }
    }

    return suite;
  }
}

export async function loadTestFilesInProcess(rootDir: string, testFiles: string[], loadErrors: LoadError[]): Promise<Suite> {
  const testLoader = new TestLoader(rootDir);
  const rootSuite = new Suite('', 'root');
  for (const file of testFiles) {
    const fileSuite = await testLoader.loadTestFile(file, 'loader', loadErrors);
    rootSuite._addSuite(fileSuite);
  }
  // Generate hashes.
  PoolBuilder.buildForLoader(rootSuite, loadErrors);
  return rootSuite;
}
