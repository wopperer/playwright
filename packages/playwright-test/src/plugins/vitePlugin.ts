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

import fs from 'fs';
import type { Suite } from '../../types/testReporter';
import path from 'path';
import type { InlineConfig, Plugin } from 'vite';
import type { TestRunnerPlugin } from '.';
import { parse, traverse, types as t } from '../common/babelBundle';
import { stoppable } from '../utilsBundle';
import type { ComponentInfo } from '../common/tsxTransform';
import { collectComponentUsages, componentInfo } from '../common/tsxTransform';
import type { FullConfig } from '../common/types';
import { assert, calculateSha1 } from 'playwright-core/lib/utils';
import type { AddressInfo } from 'net';
import { getPlaywrightVersion } from 'playwright-core/lib/utils';
import type { PlaywrightTestConfig as BasePlaywrightTestConfig } from '@playwright/test';

let stoppableServer: any;
const playwrightVersion = getPlaywrightVersion();

type CtConfig = BasePlaywrightTestConfig['use'] & {
  ctPort?: number;
  ctTemplateDir?: string;
  ctCacheDir?: string;
  ctViteConfig?: InlineConfig | (() => Promise<InlineConfig>);
};

const importReactRE = /(^|\n)import\s+(\*\s+as\s+)?React(,|\s+)/;
const compiledReactRE = /(const|var)\s+React\s*=/;

export function createPlugin(
  registerSourceFile: string,
  frameworkPluginFactory: () => Promise<Plugin>): TestRunnerPlugin {
  let configDir: string;
  let config: FullConfig;
  return {
    name: 'playwright-vite-plugin',

    setup: async (configObject: FullConfig, configDirectory: string) => {
      config = configObject;
      configDir = configDirectory;
    },

    begin: async (suite: Suite) => {
      const use = config.projects[0].use as CtConfig;
      const port = use.ctPort || 3100;
      const viteConfig = typeof use.ctViteConfig === 'function' ? await use.ctViteConfig() : (use.ctViteConfig || {});
      const relativeTemplateDir = use.ctTemplateDir || 'playwright';

      const rootDir = viteConfig.root || configDir;
      const templateDir = path.join(rootDir, relativeTemplateDir);
      const outDir = viteConfig?.build?.outDir || (use.ctCacheDir ? path.resolve(rootDir, use.ctCacheDir) : path.resolve(templateDir, '.cache'));

      const buildInfoFile = path.join(outDir, 'metainfo.json');
      let buildExists = false;
      let buildInfo: BuildInfo;

      const registerSource = await fs.promises.readFile(registerSourceFile, 'utf-8');
      const registerSourceHash = calculateSha1(registerSource);

      const { version: viteVersion } = require('vite/package.json');
      try {
        buildInfo = JSON.parse(await fs.promises.readFile(buildInfoFile, 'utf-8')) as BuildInfo;
        assert(buildInfo.version === playwrightVersion);
        assert(buildInfo.viteVersion === viteVersion);
        assert(buildInfo.registerSourceHash === registerSourceHash);
        buildExists = true;
      } catch (e) {
        buildInfo = {
          version: playwrightVersion,
          viteVersion,
          registerSourceHash,
          components: [],
          tests: {},
          sources: {},
        };
      }

      const componentRegistry: ComponentRegistry = new Map();
      // 1. Re-parse changed tests and collect required components.
      const hasNewTests = await checkNewTests(suite, buildInfo, componentRegistry);
      // 2. Check if the set of required components has changed.
      const hasNewComponents = await checkNewComponents(buildInfo, componentRegistry);
      // 3. Check component sources.
      const sourcesDirty = !buildExists || hasNewComponents || await checkSources(buildInfo);

      viteConfig.root = rootDir;
      viteConfig.preview = { port, ...viteConfig.preview };
      viteConfig.build = {
        outDir
      };

      // React heuristic. If we see a component in a file with .js extension,
      // consider it a potential JSX-in-JS scenario and enable JSX loader for all
      // .js files.
      if (hasJSComponents(buildInfo.components)) {
        viteConfig.esbuild = {
          loader: 'jsx',
          include: /.*\.jsx?$/,
          exclude: [],
        };
        viteConfig.optimizeDeps = {
          esbuildOptions: {
            loader: { '.js': 'jsx' },
          }
        };
      }
      const { build, preview } = require('vite');
      // Build config unconditionally, either build or build & preview will use it.
      viteConfig.plugins = viteConfig.plugins || [
        await frameworkPluginFactory()
      ];
      // But only add out own plugin when we actually build / transform.
      if (sourcesDirty)
        viteConfig.plugins.push(vitePlugin(registerSource, relativeTemplateDir, buildInfo, componentRegistry));
      viteConfig.configFile = viteConfig.configFile || false;
      viteConfig.define = viteConfig.define || {};
      viteConfig.define.__VUE_PROD_DEVTOOLS__ = true;
      viteConfig.css = viteConfig.css || {};
      viteConfig.css.devSourcemap = true;
      viteConfig.build = {
        ...viteConfig.build,
        target: 'esnext',
        minify: false,
        rollupOptions: {
          treeshake: false,
          input: {
            index: path.join(templateDir, 'index.html')
          },
        },
        sourcemap: true,
      };

      if (sourcesDirty) {
        await build(viteConfig);
        await fs.promises.rename(`${outDir}/${relativeTemplateDir}/index.html`, `${outDir}/index.html`);
      }

      if (hasNewTests || hasNewComponents || sourcesDirty)
        await fs.promises.writeFile(buildInfoFile, JSON.stringify(buildInfo, undefined, 2));

      const previewServer = await preview(viteConfig);
      stoppableServer = stoppable(previewServer.httpServer, 0);
      const isAddressInfo = (x: any): x is AddressInfo => x?.address;
      const address = previewServer.httpServer.address();
      if (isAddressInfo(address)) {
        const protocol = viteConfig.preview.https ? 'https:' : 'http:';
        process.env.PLAYWRIGHT_TEST_BASE_URL = `${protocol}//localhost:${address.port}`;
      }
    },

    teardown: async () => {
      await new Promise(f => stoppableServer.stop(f));
    },
  };
}

type BuildInfo = {
  version: string,
  viteVersion: string,
  registerSourceHash: string,
  sources: {
    [key: string]: {
      timestamp: number;
    }
  };
  components: ComponentInfo[];
  tests: {
    [key: string]: {
      timestamp: number;
      components: string[];
    }
  };
};

type ComponentRegistry = Map<string, ComponentInfo>;

async function checkSources(buildInfo: BuildInfo): Promise<boolean> {
  for (const [source, sourceInfo] of Object.entries(buildInfo.sources)) {
    try {
      const timestamp = (await fs.promises.stat(source)).mtimeMs;
      if (sourceInfo.timestamp !== timestamp)
        return true;
    } catch (e) {
      return true;
    }
  }
  return false;
}

async function checkNewTests(suite: Suite, buildInfo: BuildInfo, componentRegistry: ComponentRegistry): Promise<boolean> {
  const testFiles = new Set<string>();
  for (const project of suite.suites) {
    for (const file of project.suites)
      testFiles.add(file.location!.file);
  }

  let hasNewTests = false;
  for (const testFile of testFiles) {
    const timestamp = (await fs.promises.stat(testFile)).mtimeMs;
    if (buildInfo.tests[testFile]?.timestamp !== timestamp) {
      const components = await parseTestFile(testFile);
      for (const component of components)
        componentRegistry.set(component.fullName, component);
      buildInfo.tests[testFile] = { timestamp, components: components.map(c => c.fullName) };
      hasNewTests = true;
    } else {
      // The test has not changed, populate component registry from the buildInfo.
      for (const componentName of buildInfo.tests[testFile].components) {
        const component = buildInfo.components.find(c => c.fullName === componentName)!;
        componentRegistry.set(component.fullName, component);
      }
    }
  }

  return hasNewTests;
}

async function checkNewComponents(buildInfo: BuildInfo, componentRegistry: ComponentRegistry): Promise<boolean> {
  const newComponents = [...componentRegistry.keys()];
  const oldComponents = new Set(buildInfo.components.map(c => c.fullName));

  let hasNewComponents = false;
  for (const c of newComponents) {
    if (!oldComponents.has(c)) {
      hasNewComponents = true;
      break;
    }
  }
  if (!hasNewComponents)
    return false;
  buildInfo.components = newComponents.map(n => componentRegistry.get(n)!);
  return true;
}

async function parseTestFile(testFile: string): Promise<ComponentInfo[]> {
  const text = await fs.promises.readFile(testFile, 'utf-8');
  const ast = parse(text, { errorRecovery: true, plugins: ['typescript', 'jsx'], sourceType: 'module' });
  const componentUsages = collectComponentUsages(ast);
  const result: ComponentInfo[] = [];

  traverse(ast, {
    enter: p => {
      if (t.isImportDeclaration(p.node)) {
        const importNode = p.node;
        if (!t.isStringLiteral(importNode.source))
          return;

        for (const specifier of importNode.specifiers) {
          if (!componentUsages.names.has(specifier.local.name))
            continue;
          if (t.isImportNamespaceSpecifier(specifier))
            continue;
          result.push(componentInfo(specifier, importNode.source.value, testFile));
        }
      }
    }
  });

  return result;
}

function vitePlugin(registerSource: string, relativeTemplateDir: string, buildInfo: BuildInfo, componentRegistry: ComponentRegistry): Plugin {
  buildInfo.sources = {};
  return {
    name: 'playwright:component-index',

    transform: async (content, id) => {
      const queryIndex = id.indexOf('?');
      const file = queryIndex !== -1 ? id.substring(0, queryIndex) : id;
      if (!buildInfo.sources[file]) {
        try {
          const timestamp = (await fs.promises.stat(file)).mtimeMs;
          buildInfo.sources[file] = { timestamp };
        } catch {
          // Silent if can't read the file.
        }
      }

      // Vite React plugin will do this for .jsx files, but not .js files.
      if (id.endsWith('.js') && content.includes('React.createElement') && !content.match(importReactRE) && !content.match(compiledReactRE)) {
        const code = `import React from 'react';\n${content}`;
        return { code, map: { mappings: '' } };
      }

      const indexTs = path.join(relativeTemplateDir, 'index.ts');
      const indexTsx = path.join(relativeTemplateDir, 'index.tsx');
      const indexJs = path.join(relativeTemplateDir, 'index.js');
      const idResolved = path.resolve(id);
      if (!idResolved.endsWith(indexTs) && !idResolved.endsWith(indexTsx) && !idResolved.endsWith(indexJs))
        return;

      const folder = path.dirname(id);
      const lines = [content, ''];
      lines.push(registerSource);

      for (const [alias, value] of componentRegistry) {
        const importPath = value.isModuleOrAlias ? value.importPath : './' + path.relative(folder, value.importPath).replace(/\\/g, '/');
        if (value.importedName)
          lines.push(`import { ${value.importedName} as ${alias} } from '${importPath}';`);
        else
          lines.push(`import ${alias} from '${importPath}';`);
      }

      lines.push(`register({ ${[...componentRegistry.keys()].join(',\n  ')} });`);
      return {
        code: lines.join('\n'),
        map: { mappings: '' }
      };
    },
  };
}

function hasJSComponents(components: ComponentInfo[]): boolean {
  for (const component of components) {
    const extname = path.extname(component.importPath);
    if (extname === '.js' || !extname && fs.existsSync(component.importPath + '.js'))
      return true;
  }
  return false;
}
