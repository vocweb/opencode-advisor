import type { Plugin } from "@opencode-ai/plugin"
import { createAdvisorHooks } from "./plugin.ts"

/**
 * opencode loads every export of a plugin module as a plugin, so this file must export exactly one thing.
 * Everything else lives in the other modules (and is unit-tested there).
 */
export const AdvisorPlugin: Plugin = async (input) => createAdvisorHooks(input)
