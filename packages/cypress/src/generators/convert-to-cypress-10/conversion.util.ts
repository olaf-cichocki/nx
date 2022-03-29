import {
  joinPathFragments,
  ProjectConfiguration,
  readJson,
  readProjectConfiguration,
  Tree,
  updateProjectConfiguration,
  visitNotIgnoredFiles,
} from '@nrwl/devkit';
import { inspect } from 'util';
import { basename, dirname, extname } from 'path';
import { tsquery } from '@phenomnomnominal/tsquery';
import { StringLiteral } from 'typescript';
import { CypressConvertOptions } from './schema';
import { installedCypressVersion } from '../../utils/cypress-version';

const validFilesEndingsToUpdate = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
];

export function updateProject(tree: Tree, options: CypressConvertOptions) {
  const projectConfig = readProjectConfiguration(tree, options.project);
  for (const target of options.targets) {
    const { shouldUpgrade, cypressConfigPathTs, cypressConfigPathJson } =
      verifyProjectForUpgrade(tree, projectConfig, target);

    if (!shouldUpgrade) {
      continue;
    }

    const cypressConfigs = createNewCypressConfig(
      tree,
      projectConfig,
      cypressConfigPathJson
    );

    updateProjectPaths(tree, projectConfig, cypressConfigs);

    tree.write(
      cypressConfigPathTs,
      String.raw`
import { defineConfig } from 'cypress'

export default defineConfig(${inspect(cypressConfigs.cypressConfigTs)})
  `
    );

    tree.delete(cypressConfigPathJson);

    projectConfig.targets[target].options = {
      ...projectConfig.targets[target].options,
      cypressConfig: cypressConfigPathTs,
      testingType: 'e2e',
    };
  }

  updateProjectConfiguration(tree, options.project, projectConfig);
}

/**
 * validate that the provided project target is using the cypress executor
 * and there is a cypress.json file and NOT a cypress.config.ts file
 */
export function verifyProjectForUpgrade(
  tree: Tree,
  projectConfig: ProjectConfiguration,
  target: string
): {
  shouldUpgrade: boolean;
  cypressConfigPathJson: string;
  cypressConfigPathTs: string;
} {
  // make sure we have a cypress executor and a cypress.json file and NOT a cypress.config.ts file
  const cypressConfigPathJson =
    projectConfig.targets[target].options.cypressConfig ||
    joinPathFragments(projectConfig.root, 'cypress.json');

  const cypressConfigPathTs = joinPathFragments(
    projectConfig.root,
    'cypress.config.ts'
  );

  let shouldUpgrade = false;

  if (installedCypressVersion() < 9) {
    console.warn(
      `Please upgrade to Cypress version 9 before trying to convert the project to Cypress version 10.`
    );
    return {
      cypressConfigPathJson,
      cypressConfigPathTs,
      shouldUpgrade,
    };
  }

  if (projectConfig.targets[target].executor === '@nrwl/cypress:cypress') {
    if (
      tree.exists(cypressConfigPathJson) &&
      !tree.exists(cypressConfigPathTs)
    ) {
      shouldUpgrade = true;
    }
  }

  return {
    cypressConfigPathJson,
    cypressConfigPathTs,
    shouldUpgrade,
  };
}

/**
 * update the existing cypress.json config to the new cypress.config.ts structure.
 * return both the old and new configs
 */
export function createNewCypressConfig(
  tree: Tree,
  projectConfig: ProjectConfiguration,
  cypressConfigPathJson: string
): {
  cypressConfigTs: Record<string, any>;
  cypressConfigJson: Record<string, any>;
} {
  const cypressConfigJson = readJson(tree, cypressConfigPathJson);

  const {
    baseUrl = null,
    modifyObstructiveCode = null, // cypress complains about this property do we still need it?
    integrationFolder = 'src/e2e',
    supportFile = 'src/support/e2e.ts',
    ...restOfConfig
  } = cypressConfigJson;

  const cypressConfigTs = baseUrl
    ? {
        baseUrl,
      }
    : {};

  cypressConfigTs['e2e'] = {
    ...restOfConfig,
    specPattern: 'src/e2e/**/*.cy.{js,jsx,ts,tsx}',
    // only modify if files/folders are where we expect them to be.
    // if they were null, then we are defaulting to new paths.
    supportFile: tree.exists(
      joinPathFragments(projectConfig.sourceRoot, 'support', 'index.ts')
    )
      ? 'src/support/e2e.ts'
      : supportFile,
    integrationFolder: tree.exists(
      joinPathFragments(projectConfig.sourceRoot, 'integration')
    )
      ? 'src/e2e'
      : integrationFolder,
  };

  return { cypressConfigTs, cypressConfigJson };
}

export function updateProjectPaths(
  tree: Tree,
  projectConfig: ProjectConfiguration,
  {
    cypressConfigTs,
    cypressConfigJson,
  }: {
    cypressConfigTs: Record<string, any>;
    cypressConfigJson: Record<string, any>;
  }
) {
  const { integrationFolder, supportFile } = cypressConfigTs['e2e'];

  const oldIntegrationFolder = joinPathFragments(
    projectConfig.root,
    cypressConfigJson.integrationFolder
  );
  const newIntegrationFolder = joinPathFragments(
    projectConfig.root,
    integrationFolder
  );

  const oldSupportFile = joinPathFragments(
    projectConfig.root,
    cypressConfigJson.supportFile
  );

  const newSupportFile = joinPathFragments(projectConfig.root, supportFile);

  tree.rename(oldSupportFile, newSupportFile);

  // take ../support => ../support/e2e.ts
  // first take apps/app-e2e/support/index.ts => support (this cant have a / in it. must grab the leaf)
  // but if leaf is index.ts then grab the parent directory
  // then take apps/app-e2e/support/e2e.ts => support/e2e

  // "e2e"
  const newRelativeImportPath = basename(
    newSupportFile,
    extname(newSupportFile)
  );

  // "support"
  const newImportParentDirectory = basename(dirname(newSupportFile));

  // "support/e2e"
  const newImportLeafPath = joinPathFragments(
    newImportParentDirectory,
    newRelativeImportPath
  );

  // "index"
  const oldRelativeImportPath = basename(
    oldSupportFile,
    extname(oldSupportFile)
  );

  // "support"
  const oldImportParentDirectory = basename(dirname(oldSupportFile));

  // don't import from 'support/index' it's just 'support'
  const oldImportLeafPath =
    oldRelativeImportPath === 'index'
      ? oldImportParentDirectory
      : oldRelativeImportPath;

  // tree.rename doesn't work on directories must update each file within
  // the directory to the new directory

  visitNotIgnoredFiles(tree, projectConfig.sourceRoot, (path) => {
    if (!path.includes(oldIntegrationFolder)) {
      return;
    }
    const fileName = basename(path);
    let newPath = path.replace(oldIntegrationFolder, newIntegrationFolder);

    if (fileName.includes('.spec.')) {
      newPath = newPath.replace('.spec.', '.cy.');
    }
    // renaming with no same path is a noop
    tree.rename(path, newPath);

    if (validFilesEndingsToUpdate.some((e) => path.endsWith(e))) {
      updateImports(tree, newPath, oldImportLeafPath, newImportLeafPath);
    }
  });

  if (tree.children(oldIntegrationFolder).length === 0) {
    tree.delete(oldIntegrationFolder);
  }
}

export function updateImports(
  tree: Tree,
  filePath: string,
  oldImportPath: string,
  newImportPath: string
) {
  const endOfImportSelector = `StringLiteral[value=/${oldImportPath}$/]`;
  const fileContent = tree.read(filePath, 'utf-8');
  const newContent = tsquery.replace(
    fileContent,
    endOfImportSelector,
    (node: StringLiteral) => {
      return `'${node.text.replace(oldImportPath, newImportPath)}'`;
    }
  );
  tree.write(filePath, newContent);
}
