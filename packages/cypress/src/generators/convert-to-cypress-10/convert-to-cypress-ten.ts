import {
  formatFiles,
  installPackagesTask,
  Tree,
  updateJson,
} from '@nrwl/devkit';
import { forEachExecutorOptions } from '@nrwl/workspace/src/utilities/executor-options-utils';
import { CypressExecutorOptions } from '../../executors/cypress/cypress.impl';
import { updateProject } from './conversion.util';

const TMP_CYPRESS_VERSION =
  'https://cdn.cypress.io/beta/npm/10.0.0/circle-10.0-release-ee08f4ae95ca2c1c442c5c699395710ff1c145e6/cypress.tgz';

async function normalizeOptions(options: CypressConvertOptions) {
  if (options.project && options.all) {
    throw new Error(
      'Cannot specify both --project and --all. They are mutually exclusive'
    );
  }

  if (!options.project && !options.all) {
    throw new Error(
      'Missing project to convert. Specify --project OR --all to convert all e2e projects'
    );
  }

  return options;
}

export async function convertCypressProject(
  tree: Tree,
  options: CypressConvertOptions
) {
  options = await normalizeOptions(options);

  if (options.all) {
    forEachExecutorOptions(
      tree,
      '@nrwl/cypress:cypress',
      (currentValue: CypressExecutorOptions, project) => {
        updateProject(tree, {
          ...options,
          project,
        });
      }
    );
  } else {
    updateProject(tree, options);
  }

  updateJson(tree, 'package.json', (json) => {
    json.devDependencies['cypress'] = TMP_CYPRESS_VERSION;
    return json;
  });

  return () => {
    formatFiles(tree);
    installPackagesTask(tree);
  };
}

export default convertCypressProject;
