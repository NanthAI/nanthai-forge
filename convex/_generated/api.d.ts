import type * as projectHostedLogCleanupStore from "../projectHostedLogCleanupStore.js";
import type * as projectCheckLogRetentionActions from "../projectCheckLogRetentionActions.js";
import type * as projectCheckLogRetention from "../projectCheckLogRetention.js";
import type * as projectCheckLogCleanup from "../projectCheckLogCleanup.js";
import type * as projectCheckLogCleanupStore from "../projectCheckLogCleanupStore.js";
import type * as artifactBlobFields from "../artifactBlobFields.js";
import type * as artifactStorage from "../artifactStorage.js";
import type * as importStorage from "../importStorage.js";
import type * as projectArtifactActions from "../projectArtifactActions.js";
import type * as projectReturnCommit from "../projectReturnCommit.js";
import type * as projectPublicationAttempt from "../projectPublicationAttempt.js";
import type * as projectReturnMetadataStore from "../projectReturnMetadataStore.js";
import type * as projectPublicationProgress from "../projectPublicationProgress.js";
import type * as projectPublicationStore from "../projectPublicationStore.js";
import type * as importStatus from "../importStatus.js";
import type * as projectBootstrap from "../projectBootstrap.js";
import type * as projectBootstrapStore from "../projectBootstrapStore.js";
/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as clientErrors from "../clientErrors.js";
import type * as importRemoval from "../importRemoval.js";
import type * as urlAccounts from "../urlAccounts.js";
import type * as urlProjects from "../urlProjects.js";
import type * as urlsBackfill from "../urlsBackfill.js";
import type * as urlIdentity from "../urlIdentity.js";
import type * as ownerLifecycle from "../ownerLifecycle.js";
import type * as ownerAcceptance from "../ownerAcceptance.js";
import type * as projectProposalObjects from "../projectProposalObjects.js";
import type * as projectBackupObjects from "../projectBackupObjects.js";
import type * as projectSourceReturnProgress from "../projectSourceReturnProgress.js";
import type * as projectReturnIndexStage from "../projectReturnIndexStage.js";
import type * as projectWorkCommand from "../projectWorkCommand.js";
import type * as projectWorkIndexSummary from "../projectWorkIndexSummary.js";
import type * as projectActorNames from "../projectActorNames.js";
import type * as projectActorFields from "../projectActorFields.js";
import type * as projectPeopleActions from "../projectPeopleActions.js";
import type * as projectWorkAncestry from "../projectWorkAncestry.js";
import type * as projectIntentMigration from "../projectIntentMigration.js";
import type * as projectIntentMigrationActions from "../projectIntentMigrationActions.js";
import type * as projectWorkLoad from "../projectWorkLoad.js";
import type * as projectAcceptance from "../projectAcceptance.js";
import type * as projectAutonomy from "../projectAutonomy.js";
import type * as autonomyFields from "../autonomyFields.js";
import type * as projectObjectRecipes from "../projectObjectRecipes.js";
import type * as projectObjectRecipeStore from "../projectObjectRecipeStore.js";
import type * as agentBriefFields from "../agentBriefFields.js";
import type * as agentGuidance from "../agentGuidance.js";
import type * as projectBriefingContext from "../projectBriefingContext.js";
import type * as projectBriefings from "../projectBriefings.js";
import type * as projectBriefingActions from "../projectBriefingActions.js";
import type * as projectBriefingSources from "../projectBriefingSources.js";
import type * as deviceActions from "../deviceActions.js";
import type * as deviceStore from "../deviceStore.js";
import type * as deviceCredentials from "../deviceCredentials.js";
import type * as access from "../access.js";
import type * as accountActions from "../accountActions.js";
import type * as accountExecute from "../accountExecute.js";
import type * as accountMetadata from "../accountMetadata.js";
import type * as accountPlan from "../accountPlan.js";
import type * as accountResources from "../accountResources.js";
import type * as accountTypes from "../accountTypes.js";
import type * as agentActions from "../agentActions.js";
import type * as agentGrants from "../agentGrants.js";
import type * as artifacts from "../artifacts.js";
import type * as coordinationFeed from "../coordinationFeed.js";
import type * as coordinationFields from "../coordinationFields.js";
import type * as coordinationReturnChanges from "../coordinationReturnChanges.js";
import type * as coordinationWrite from "../coordinationWrite.js";
import type * as derivedArtifactActions from "../derivedArtifactActions.js";
import type * as derivedArtifactFields from "../derivedArtifactFields.js";
import type * as derivedArtifacts from "../derivedArtifacts.js";
import type * as errors from "../errors.js";
import type * as hosted from "../hosted.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as indexer from "../indexer.js";
import type * as interestActions from "../interestActions.js";
import type * as interests from "../interests.js";
import type * as lifecycle from "../lifecycle.js";
import type * as lifecycleActions from "../lifecycleActions.js";
import type * as projectArchiveMetadata from "../projectArchiveMetadata.js";
import type * as projectArchivePart from "../projectArchivePart.js";
import type * as projectAuthority from "../projectAuthority.js";
import type * as projectBackupActions from "../projectBackupActions.js";
import type * as projectBackups from "../projectBackups.js";
import type * as projectContributorActions from "../projectContributorActions.js";
import type * as projectContributors from "../projectContributors.js";
import type * as projectCoordination from "../projectCoordination.js";
import type * as projectCoordinationReads from "../projectCoordinationReads.js";
import type * as projectExchange from "../projectExchange.js";
import type * as projectExchangeActions from "../projectExchangeActions.js";
import type * as projectExchangeCache from "../projectExchangeCache.js";
import type * as projectExchangeMigration from "../projectExchangeMigration.js";
import type * as projectLifecycle from "../projectLifecycle.js";
import type * as projectObjectCleanup from "../projectObjectCleanup.js";
import type * as projectObjectFields from "../projectObjectFields.js";
import type * as projectObjectLifecycle from "../projectObjectLifecycle.js";
import type * as projectObjectCommit from "../projectObjectCommit.js";
import type * as projectObjectDownloads from "../projectObjectDownloads.js";
import type * as projectObjects from "../projectObjects.js";
import type * as projectObjectValidation from "../projectObjectValidation.js";
import type * as projectExchangeValidation from "../projectExchangeValidation.js";
import type * as projectProposalActions from "../projectProposalActions.js";
import type * as projectProposals from "../projectProposals.js";
import type * as projectSourceReturn from "../projectSourceReturn.js";
import type * as projectSourceReview from "../projectSourceReview.js";
import type * as projectStorage from "../projectStorage.js";
import type * as projectWorkIndex from "../projectWorkIndex.js";
import type * as projectWorkIndexStore from "../projectWorkIndexStore.js";
import type * as projectWorkIndexActions from "../projectWorkIndexActions.js";
import type * as projectWorkIndexedCommand from "../projectWorkIndexedCommand.js";
import type * as projectWorkIndexFields from "../projectWorkIndexFields.js";
import type * as projectViewReads from "../projectViewReads.js";
import type * as projectViewActions from "../projectViewActions.js";
import type * as projectWork from "../projectWork.js";
import type * as projectWorkActions from "../projectWorkActions.js";
import type * as remote from "../remote.js";
import type * as savedViewActions from "../savedViewActions.js";
import type * as savedViews from "../savedViews.js";
import type * as secretActions from "../secretActions.js";
import type * as secretLifecycle from "../secretLifecycle.js";
import type * as secrets from "../secrets.js";
import type * as sharing from "../sharing.js";
import type * as sharingActions from "../sharingActions.js";
import type * as sourceZones from "../sourceZones.js";
import type * as storageDigest from "../storageDigest.js";
import type * as sync from "../sync.js";
import type * as syncActions from "../syncActions.js";
import type * as teamActions from "../teamActions.js";
import type * as teamLifecycle from "../teamLifecycle.js";
import type * as teams from "../teams.js";
import type * as workMetadataSidecar from "../workMetadataSidecar.js";
import type * as zoneActions from "../zoneActions.js";

import type * as projectGithubImport from "../projectGithubImport.js";

import type * as projectGithubImportStore from "../projectGithubImportStore.js";

import type * as projectGithubImportWorker from "../projectGithubImportWorker.js";

import type * as projectGithubImportObjects from "../projectGithubImportObjects.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  projectCheckLogRetention: typeof projectCheckLogRetention;
  projectCheckLogRetentionActions: typeof projectCheckLogRetentionActions;
  projectHostedLogCleanupStore: typeof projectHostedLogCleanupStore;

  projectCheckLogCleanup: typeof projectCheckLogCleanup;
  projectCheckLogCleanupStore: typeof projectCheckLogCleanupStore;
  artifactBlobFields: typeof artifactBlobFields;
  artifactStorage: typeof artifactStorage;
  importStorage: typeof importStorage;
  projectArtifactActions: typeof projectArtifactActions;
  projectReturnCommit: typeof projectReturnCommit;
  importStatus: typeof importStatus;
  projectGithubImportObjects: typeof projectGithubImportObjects;
  projectGithubImportWorker: typeof projectGithubImportWorker;
  projectGithubImportStore: typeof projectGithubImportStore;
  projectGithubImport: typeof projectGithubImport;
  projectBootstrap: typeof projectBootstrap;
  projectBootstrapStore: typeof projectBootstrapStore;
  importRemoval: typeof importRemoval;
  urlAccounts: typeof urlAccounts;
  urlProjects: typeof urlProjects;
  urlsBackfill: typeof urlsBackfill;
  urlIdentity: typeof urlIdentity;

  ownerLifecycle: typeof ownerLifecycle;
  ownerAcceptance: typeof ownerAcceptance;
  projectSourceReturnProgress: typeof projectSourceReturnProgress;
  projectReturnIndexStage: typeof projectReturnIndexStage;
  projectReturnMetadataStore: typeof projectReturnMetadataStore;
  projectProposalObjects: typeof projectProposalObjects;
  projectBackupObjects: typeof projectBackupObjects;
  projectWorkCommand: typeof projectWorkCommand;
  projectIntentMigration: typeof projectIntentMigration;
  projectIntentMigrationActions: typeof projectIntentMigrationActions;
  projectWorkLoad: typeof projectWorkLoad;
  projectAcceptance: typeof projectAcceptance;
  projectAutonomy: typeof projectAutonomy;
  autonomyFields: typeof autonomyFields;
  deviceActions: typeof deviceActions;
  deviceStore: typeof deviceStore;
  deviceCredentials: typeof deviceCredentials;

  projectObjectRecipes: typeof projectObjectRecipes;
  projectObjectRecipeStore: typeof projectObjectRecipeStore;
  agentBriefFields: typeof agentBriefFields;
  agentGuidance: typeof agentGuidance;
  projectBriefingContext: typeof projectBriefingContext;
  projectBriefings: typeof projectBriefings;
  projectBriefingActions: typeof projectBriefingActions;
  projectBriefingSources: typeof projectBriefingSources;
  access: typeof access;
  accountActions: typeof accountActions;
  accountExecute: typeof accountExecute;
  accountMetadata: typeof accountMetadata;
  accountPlan: typeof accountPlan;
  accountResources: typeof accountResources;
  accountTypes: typeof accountTypes;
  agentActions: typeof agentActions;
  agentGrants: typeof agentGrants;
  artifacts: typeof artifacts;
  clientErrors: typeof clientErrors;
  coordinationFeed: typeof coordinationFeed;
  coordinationFields: typeof coordinationFields;
  coordinationReturnChanges: typeof coordinationReturnChanges;
  coordinationWrite: typeof coordinationWrite;
  derivedArtifactActions: typeof derivedArtifactActions;
  derivedArtifactFields: typeof derivedArtifactFields;
  derivedArtifacts: typeof derivedArtifacts;
  errors: typeof errors;
  hosted: typeof hosted;
  http: typeof http;
  imports: typeof imports;
  indexer: typeof indexer;
  interestActions: typeof interestActions;
  interests: typeof interests;
  lifecycle: typeof lifecycle;
  lifecycleActions: typeof lifecycleActions;
  projectArchiveMetadata: typeof projectArchiveMetadata;
  projectArchivePart: typeof projectArchivePart;
  projectAuthority: typeof projectAuthority;
  projectBackupActions: typeof projectBackupActions;
  projectBackups: typeof projectBackups;
  projectContributorActions: typeof projectContributorActions;
  projectContributors: typeof projectContributors;
  projectCoordination: typeof projectCoordination;
  projectCoordinationReads: typeof projectCoordinationReads;
  projectExchange: typeof projectExchange;
  projectPublicationProgress: typeof projectPublicationProgress;
  projectPublicationStore: typeof projectPublicationStore;
  projectPublicationAttempt: typeof projectPublicationAttempt;
  projectExchangeActions: typeof projectExchangeActions;
  projectExchangeCache: typeof projectExchangeCache;
  projectExchangeMigration: typeof projectExchangeMigration;
  projectLifecycle: typeof projectLifecycle;
  projectObjectCleanup: typeof projectObjectCleanup;
  projectObjectFields: typeof projectObjectFields;
  projectObjectLifecycle: typeof projectObjectLifecycle;
  projectObjectCommit: typeof projectObjectCommit;
  projectObjectDownloads: typeof projectObjectDownloads;
  projectObjects: typeof projectObjects;
  projectObjectValidation: typeof projectObjectValidation;
  projectExchangeValidation: typeof projectExchangeValidation;
  projectProposalActions: typeof projectProposalActions;
  projectProposals: typeof projectProposals;
  projectSourceReturn: typeof projectSourceReturn;
  projectSourceReview: typeof projectSourceReview;
  projectStorage: typeof projectStorage;
  projectWorkIndexSummary: typeof projectWorkIndexSummary;
  projectActorNames: typeof projectActorNames;
  projectActorFields: typeof projectActorFields;
  projectPeopleActions: typeof projectPeopleActions;
  projectWorkAncestry: typeof projectWorkAncestry;
  projectWorkIndex: typeof projectWorkIndex;
  projectWorkIndexStore: typeof projectWorkIndexStore;
  projectWorkIndexActions: typeof projectWorkIndexActions;
  projectWorkIndexedCommand: typeof projectWorkIndexedCommand;
  projectWorkIndexFields: typeof projectWorkIndexFields;
  projectViewReads: typeof projectViewReads;
  projectViewActions: typeof projectViewActions;
  projectWork: typeof projectWork;
  projectWorkActions: typeof projectWorkActions;
  remote: typeof remote;
  savedViewActions: typeof savedViewActions;
  savedViews: typeof savedViews;
  secretActions: typeof secretActions;
  secretLifecycle: typeof secretLifecycle;
  secrets: typeof secrets;
  sharing: typeof sharing;
  sharingActions: typeof sharingActions;
  sourceZones: typeof sourceZones;
  storageDigest: typeof storageDigest;
  sync: typeof sync;
  syncActions: typeof syncActions;
  teamActions: typeof teamActions;
  teamLifecycle: typeof teamLifecycle;
  teams: typeof teams;
  workMetadataSidecar: typeof workMetadataSidecar;
  zoneActions: typeof zoneActions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
