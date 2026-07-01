import { PATH_BEARING_TOOLS } from "./path-surfaces";
import type { ToolAccessExtractorLookup } from "./tool-access-extractor-registry";
import { getNonEmptyString, toRecord } from "./value-guards";

export function getPathBearingToolPath(
  toolName: string,
  input: unknown,
): string | null {
  if (toolName === "bash" || toolName === "mcp") {
    return null;
  }

  return getNonEmptyString(toRecord(input).path);
}

/**
 * Extract the filesystem path a tool will access, for the cross-cutting `path`
 * and `external_directory` gates.
 *
 * Unlike {@link getPathBearingToolPath} (plain `input.path` only), this also
 * recognizes custom extractor keys and MCP tools:
 *
 * - `bash` → `null` (bash has its own token-based path gates).
 * - Built-in path-bearing tools → `input.path`.
 * - `mcp` → `input.arguments.path`.
 * - Any other tool → a registered {@link ToolAccessExtractor}'s path, else the
 *   default `input.path` convention.
 */
export function getToolInputPath(
  toolName: string,
  input: unknown,
  extractors?: ToolAccessExtractorLookup,
): string | null {
  if (toolName === "bash") {
    return null;
  }

  const record = toRecord(input);

  if (PATH_BEARING_TOOLS.has(toolName)) {
    return getNonEmptyString(record.path);
  }

  if (toolName === "mcp") {
    return getNonEmptyString(toRecord(record.arguments).path);
  }

  const custom = extractors?.get(toolName);
  if (custom) {
    return getNonEmptyString(custom(record));
  }

  return getNonEmptyString(record.path);
}
