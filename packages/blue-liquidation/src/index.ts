export type { Env, SenseConfig, ActConfig } from './config'
export { loadSenseConfig, loadActConfig } from './config'
export { DOMAIN, formatOpportunityId, parseOpportunityId } from './wire'
export type { ParsedOpportunityId } from './wire'
export { runSense, senseOnce } from './sense/sense'
export type { BlueSenseCache, SenseCounters } from './sense/sense'
export { runAct, actOnce } from './act/act'
export type { BlueActStatus, BlueActCache, ActCounters } from './act/act'

/** Bumped when a stage's disposable cache shape changes; a mismatched cache is rebuilt, not migrated. */
export const SENSE_CACHE_VERSION = 1
export const ACT_CACHE_VERSION = 1
