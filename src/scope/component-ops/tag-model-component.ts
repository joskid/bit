import bluebird from 'bluebird';
import R from 'ramda';
import * as RA from 'ramda-adjunct';
import { ReleaseType } from 'semver';
import { v4 } from 'uuid';

import { Scope } from '..';
import { BitId, BitIds } from '../../bit-id';
import loader from '../../cli/loader';
import { BEFORE_IMPORT_PUT_ON_SCOPE, BEFORE_PERSISTING_PUT_ON_SCOPE } from '../../cli/loader/loader-messages';
import { COMPONENT_ORIGINS, Extensions } from '../../constants';
import { CURRENT_SCHEMA } from '../../consumer/component/component-schema';
import Component from '../../consumer/component/consumer-component';
import Consumer from '../../consumer/consumer';
import { ComponentSpecsFailed, NewerVersionFound } from '../../consumer/exceptions';
import GeneralError from '../../error/general-error';
import ShowDoctorError from '../../error/show-doctor-error';
import ValidationError from '../../error/validation-error';
import logger from '../../logger/logger';
import { pathJoinLinux, sha1 } from '../../utils';
import { PathLinux } from '../../utils/path';
import { buildComponentsGraph } from '../graph/components-graph';
import { AutoTagResult, getAutoTagData } from './auto-tag';
import { getAllFlattenedDependencies } from './get-flattened-dependencies';
import { getValidVersionOrReleaseType } from '../../utils/semver-helper';
import { OnTagResult } from '../scope';

function updateDependenciesVersions(componentsToTag: Component[]): void {
  const getNewDependencyVersion = (id: BitId): BitId | null => {
    const foundDependency = componentsToTag.find((component) => component.id.isEqualWithoutVersion(id));
    return foundDependency ? id.changeVersion(foundDependency.version) : null;
  };
  componentsToTag.forEach((oneComponentToTag) => {
    oneComponentToTag.getAllDependencies().forEach((dependency) => {
      const newDepId = getNewDependencyVersion(dependency.id);
      if (newDepId) dependency.id = newDepId;
    });
    // TODO: in case there are core extensions they should be excluded here
    oneComponentToTag.extensions.forEach((extension) => {
      if (extension.name === Extensions.dependencyResolver && extension.data && extension.data.dependencies) {
        extension.data.dependencies.forEach((dep) => {
          const depId = dep.componentId instanceof BitId ? dep.componentId : new BitId(dep.componentId);
          const newDepId = getNewDependencyVersion(depId);
          dep.componentId = newDepId || depId;
        });
      }
      // For core extensions there won't be an extensionId but name
      // We only want to add version to external extensions not core extensions
      if (!extension.extensionId) return;
      const newDepId = getNewDependencyVersion(extension.extensionId);
      if (newDepId) extension.extensionId = newDepId;
      else if (!extension.extensionId.hasScope() && !extension.extensionId.hasVersion()) {
        throw new GeneralError(`fatal: "${oneComponentToTag.id.toString()}" has an extension "${extension.extensionId.toString()}".
this extension was not included in the tag command.`);
      }
    });
  });
}

function setHashes(componentsToTag: Component[]): void {
  componentsToTag.forEach((componentToTag) => {
    componentToTag.version = sha1(v4());
  });
}

async function setFutureVersions(
  componentsToTag: Component[],
  scope: Scope,
  releaseType: ReleaseType | undefined,
  exactVersion: string | null | undefined
): Promise<void> {
  await Promise.all(
    componentsToTag.map(async (componentToTag) => {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      const modelComponent = await scope.sources.findOrAddComponent(componentToTag);
      const nextVersion = componentToTag.componentMap?.nextVersion?.version;
      if (nextVersion) {
        const exactVersionOrReleaseType = getValidVersionOrReleaseType(nextVersion);
        if (exactVersionOrReleaseType.exactVersion) exactVersion = exactVersionOrReleaseType.exactVersion;
        if (exactVersionOrReleaseType.releaseType) releaseType = exactVersionOrReleaseType.releaseType;
      }
      const version = modelComponent.getVersionToAdd(releaseType, exactVersion);
      // @ts-ignore usedVersion is needed only for this, that's why it's not declared on the instance
      componentToTag.usedVersion = componentToTag.version;
      componentToTag.version = version;
    })
  );
}

/**
 * make sure the originallySharedDir was added before saving the component. also, make sure it was
 * not added twice.
 * we need three objects for this:
 * 1) component.pendingVersion => version pending to be saved in the filesystem. we want to make sure it has the added sharedDir.
 * 2) component.componentFromModel => previous version of the component. it has the original sharedDir.
 * 3) component.componentMap => current paths in the filesystem, which don't have the sharedDir.
 *
 * The component may be changed from the componentFromModel. The files may be removed and added and
 * new files may added, so we can't compare the files of componentFromModel to component.
 *
 * What we can do is calculating the sharedDir from component.componentFromModel
 * then, make sure that calculatedSharedDir + pathFromComponentMap === component.pendingVersion
 *
 * Also, make sure that the wrapDir has been removed
 */
function validateDirManipulation(components: Component[]): void {
  const throwOnError = (expectedPath: PathLinux, actualPath: PathLinux) => {
    if (expectedPath !== actualPath) {
      throw new ValidationError(
        `failed validating the component paths with sharedDir, expected path ${expectedPath}, got ${actualPath}`
      );
    }
  };
  const validateComponent = (component: Component) => {
    if (!component.componentMap) throw new Error(`componentMap is missing from ${component.id.toString()}`);
    if (!component.componentFromModel) return;
    // component.componentFromModel.setOriginallySharedDir();
    const sharedDir = component.componentFromModel.originallySharedDir;
    const wrapDir = component.componentFromModel.wrapDir;
    const pathWithSharedDir = (pathStr: PathLinux): PathLinux => {
      // $FlowFixMe componentMap is set here
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      if (sharedDir && component.componentMap.origin === COMPONENT_ORIGINS.IMPORTED) {
        return pathJoinLinux(sharedDir, pathStr);
      }
      return pathStr;
    };
    const pathWithoutWrapDir = (pathStr: PathLinux): PathLinux => {
      if (wrapDir) {
        return pathStr.replace(`${wrapDir}/`, '');
      }
      return pathStr;
    };
    const pathAfterDirManipulation = (pathStr: PathLinux): PathLinux => {
      const withoutWrapDir = pathWithoutWrapDir(pathStr);
      return pathWithSharedDir(withoutWrapDir);
    };
    const expectedMainFile = pathAfterDirManipulation(component.componentMap.mainFile);
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    throwOnError(expectedMainFile, component.pendingVersion.mainFile);
    // $FlowFixMe componentMap is set here
    const componentMapFiles = component.componentMap.getAllFilesPaths();
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    const componentFiles = component.pendingVersion.files.map((file) => file.relativePath);
    componentMapFiles.forEach((file) => {
      const expectedFile = pathAfterDirManipulation(file);
      if (!componentFiles.includes(expectedFile)) {
        throw new ValidationError(
          `failed validating the component paths, expected a file ${expectedFile} to be in ${componentFiles.toString()} array`
        );
      }
    });
  };
  components.forEach((component) => validateComponent(component));
}

export default async function tagModelComponent({
  consumerComponents,
  scope,
  message,
  exactVersion,
  releaseType,
  force,
  consumer,
  ignoreNewestVersion = false,
  skipTests = false,
  verbose = false,
  skipAutoTag,
  persist,
  resolveUnmerged,
  isSnap = false,
}: {
  consumerComponents: Component[];
  scope: Scope;
  message: string;
  exactVersion?: string | null | undefined;
  releaseType?: ReleaseType;
  force: boolean | null | undefined;
  consumer: Consumer;
  ignoreNewestVersion?: boolean;
  skipTests: boolean;
  verbose?: boolean;
  skipAutoTag: boolean;
  persist: boolean;
  resolveUnmerged?: boolean;
  isSnap?: boolean;
}): Promise<{ taggedComponents: Component[]; autoTaggedResults: AutoTagResult[]; publishedPackages: string[] }> {
  loader.start(BEFORE_IMPORT_PUT_ON_SCOPE);
  if (!persist) skipTests = true;
  const consumerComponentsIdsMap = {};
  // Concat and unique all the dependencies from all the components so we will not import
  // the same dependency more then once, it's mainly for performance purpose
  consumerComponents.forEach((consumerComponent) => {
    const componentIdString = consumerComponent.id.toString();
    // Store it in a map so we can take it easily from the sorted array which contain only the id
    consumerComponentsIdsMap[componentIdString] = consumerComponent;
  });
  const componentsToTag: Component[] = R.values(consumerComponentsIdsMap); // consumerComponents unique
  const componentsToTagIds = componentsToTag.map((c) => c.id);

  const autoTagData = skipAutoTag ? [] : await getAutoTagData(consumer, BitIds.fromArray(componentsToTagIds));
  const autoTagConsumerComponents = autoTagData.map((autoTagItem) => autoTagItem.component);
  const allComponentsToTag = componentsToTag.concat(autoTagConsumerComponents);

  // check for each one of the components whether it is using an old version
  if (!ignoreNewestVersion && !isSnap) {
    const newestVersionsP = allComponentsToTag.map(async (component) => {
      if (component.componentFromModel) {
        // otherwise it's a new component, so this check is irrelevant
        const modelComponent = await scope.getModelComponentIfExist(component.id);
        if (!modelComponent) throw new ShowDoctorError(`component ${component.id} was not found in the model`);
        if (!modelComponent.listVersions().length) return null; // no versions yet, no issues.
        const latest = modelComponent.latest();
        if (latest !== component.version) {
          return {
            componentId: component.id.toStringWithoutVersion(),
            currentVersion: component.version,
            latestVersion: latest,
          };
        }
      }
      return null;
    });
    const newestVersions = await Promise.all(newestVersionsP);
    const newestVersionsWithoutEmpty = newestVersions.filter((newest) => newest);
    if (!RA.isNilOrEmpty(newestVersionsWithoutEmpty)) {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      throw new NewerVersionFound(newestVersionsWithoutEmpty);
    }
  }

  let testsResults = [];
  if (consumer.isLegacy) {
    logger.debugAndAddBreadCrumb('tag-model-components', 'sequentially build all components');
    await scope.buildMultiple(allComponentsToTag, consumer, false, verbose);

    logger.debug('scope.putMany: sequentially test all components');

    if (!skipTests) {
      const testsResultsP = scope.testMultiple({
        components: allComponentsToTag,
        consumer,
        verbose,
        rejectOnFailure: !force,
      });
      try {
        // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
        testsResults = await testsResultsP;
      } catch (err) {
        // if force is true, ignore the tests and continue
        if (!force) {
          // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
          if (!verbose) throw new ComponentSpecsFailed();
          throw err;
        }
      }
    }
  }

  logger.debugAndAddBreadCrumb('tag-model-components', 'sequentially persist all components');
  // go through all components and find the future versions for them
  isSnap
    ? setHashes(allComponentsToTag)
    : await setFutureVersions(allComponentsToTag, scope, releaseType, exactVersion);
  setCurrentSchema(allComponentsToTag, consumer);
  // go through all dependencies and update their versions
  updateDependenciesVersions(allComponentsToTag);
  // build the dependencies graph
  const allDependenciesGraphs = buildComponentsGraph(allComponentsToTag);

  const dependenciesCache = {};
  const notFoundDependencies = new BitIds();
  const lane = await consumer.getCurrentLaneObject();
  const persistComponent = async (consumerComponent: Component) => {
    let testResult;
    if (!skipTests) {
      testResult = testsResults.find((result) => {
        // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
        return consumerComponent.id.isEqualWithoutScopeAndVersion(result.componentId);
      });
    }
    const { flattenedDependencies, flattenedDevDependencies } = await getAllFlattenedDependencies(
      scope,
      consumerComponent.id,
      allDependenciesGraphs,
      dependenciesCache,
      notFoundDependencies
    );

    await scope.sources.addSource({
      source: consumerComponent,
      consumer,
      flattenedDependencies,
      flattenedDevDependencies,
      message,
      lane,
      specsResults: testResult ? testResult.specs : undefined,
      resolveUnmerged,
    });
    return consumerComponent;
  };

  // Run the persistence one by one not in parallel!
  loader.start(BEFORE_PERSISTING_PUT_ON_SCOPE);
  const allTaggedComponents = await bluebird.mapSeries(allComponentsToTag, (consumerComponent) =>
    persistComponent(consumerComponent)
  );
  validateDirManipulation(allTaggedComponents);

  if (persist) {
    await consumer.updateComponentsVersions(allTaggedComponents);
  } else {
    consumer.updateNextVersionOnBitmap(allTaggedComponents, exactVersion, releaseType);
  }
  const publishedPackages: string[] = [];
  if (!consumer.isLegacy && persist) {
    const ids = allTaggedComponents.map((consumerComponent) => consumerComponent.id);
    const results: Array<OnTagResult[]> = await bluebird.mapSeries(scope.onTag, (func) => func(ids));
    results.forEach((tagResult) => updateComponentsByTagResult(allTaggedComponents, tagResult));
    allTaggedComponents.forEach((comp) => {
      const pkgExt = comp.extensions.findCoreExtension('teambit.bit/pkg');
      const publishedPackage = pkgExt?.data?.publishedPackage;
      if (publishedPackage) publishedPackages.push(publishedPackage);
    });
    await bluebird.mapSeries(allTaggedComponents, (consumerComponent) => scope.sources.enrichSource(consumerComponent));
  }

  if (persist) {
    await scope.objects.persist();
  }
  const taggedComponents = allTaggedComponents.filter((taggedComp) =>
    componentsToTag.find((c) => c.id.isEqualWithoutScopeAndVersion(taggedComp.id))
  );
  return { taggedComponents, autoTaggedResults: autoTagData, publishedPackages };
}

function setCurrentSchema(components: Component[], consumer: Consumer) {
  if (consumer.isLegacy) return;
  components.forEach((component) => {
    component.schema = CURRENT_SCHEMA;
  });
}

/**
 * @todo: currently, there is only one function registered to the OnTag, which is the builder.
 * we set the extensions data and artifacts we got from the builder to the consumer-components.
 * however, if there is more than one function registered to the OnTag, the data will be overridden
 * by the last called function. when/if this happen, some kind of merge need to be done between the
 * results.
 */
function updateComponentsByTagResult(components: Component[], tagResult: OnTagResult[]) {
  tagResult.forEach((result) => {
    const matchingComponent = components.find((c) => c.id.isEqual(result.id));
    if (matchingComponent) {
      matchingComponent.extensions = result.extensions;
    }
  });
}
