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

import type { FullConfig, TestCase, TestError, TestResult, FullResult, TestStep, Reporter } from '../../types/testReporter';
import { Suite } from '../common/test';

type StdIOChunk = {
  type: 'stdout' | 'stderr';
  chunk: string | Buffer;
  test?: TestCase;
  result?: TestResult;
};

export class Multiplexer implements Reporter {
  private _reporters: Reporter[];
  private _deferredErrors: TestError[] | null = [];
  private _deferredStdIO: StdIOChunk[] | null = [];
  private _config!: FullConfig;

  constructor(reporters: Reporter[]) {
    this._reporters = reporters;
  }

  printsToStdio() {
    return this._reporters.some(r => r.printsToStdio ? r.printsToStdio() : true);
  }

  onConfigure(config: FullConfig) {
    this._config = config;
  }

  onBegin(config: FullConfig, suite: Suite) {
    for (const reporter of this._reporters)
      reporter.onBegin?.(config, suite);

    const errors = this._deferredErrors!;
    this._deferredErrors = null;
    for (const error of errors)
      this.onError(error);

    const stdios = this._deferredStdIO!;
    this._deferredStdIO = null;
    for (const stdio of stdios) {
      if (stdio.type === 'stdout')
        this.onStdOut(stdio.chunk, stdio.test, stdio.result);
      else
        this.onStdErr(stdio.chunk, stdio.test, stdio.result);
    }
  }

  onTestBegin(test: TestCase, result: TestResult) {
    for (const reporter of this._reporters)
      wrap(() => reporter.onTestBegin?.(test, result));
  }

  onStdOut(chunk: string | Buffer, test?: TestCase, result?: TestResult) {
    if (this._deferredStdIO) {
      this._deferredStdIO.push({ chunk, test, result, type: 'stdout' });
      return;
    }
    for (const reporter of this._reporters)
      wrap(() => reporter.onStdOut?.(chunk, test, result));
  }

  onStdErr(chunk: string | Buffer, test?: TestCase, result?: TestResult) {
    if (this._deferredStdIO) {
      this._deferredStdIO.push({ chunk, test, result, type: 'stderr' });
      return;
    }

    for (const reporter of this._reporters)
      wrap(() => reporter.onStdErr?.(chunk, test, result));
  }

  onTestEnd(test: TestCase, result: TestResult) {
    for (const reporter of this._reporters)
      wrap(() => reporter.onTestEnd?.(test, result));
  }

  async onEnd() { }

  async onExit(result: FullResult) {
    if (this._deferredErrors) {
      // onBegin was not reported, emit it.
      this.onBegin(this._config, new Suite('', 'root'));
    }

    for (const reporter of this._reporters)
      await Promise.resolve().then(() => reporter.onEnd?.(result)).catch(e => console.error('Error in reporter', e));

    for (const reporter of this._reporters)
      await Promise.resolve().then(() => (reporter as any).onExit?.()).catch(e => console.error('Error in reporter', e));
  }

  onError(error: TestError) {
    if (this._deferredErrors) {
      this._deferredErrors.push(error);
      return;
    }
    for (const reporter of this._reporters)
      wrap(() => reporter.onError?.(error));
  }

  onStepBegin(test: TestCase, result: TestResult, step: TestStep) {
    for (const reporter of this._reporters)
      wrap(() => (reporter as any).onStepBegin?.(test, result, step));
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    for (const reporter of this._reporters)
      (reporter as any).onStepEnd?.(test, result, step);
  }
}

function wrap(callback: () => void) {
  try {
    callback();
  } catch (e) {
    console.error('Error in reporter', e);
  }
}
