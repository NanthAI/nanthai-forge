// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { Buffer } from 'node:buffer';
import { certifyJsInbound } from './js-inbound-imports.js';
import { buildPackageGraph, PACKAGE_GRAPH_MAX_BYTES, PACKAGE_GRAPH_MAX_MANIFESTS } from './package-graph.js';
import { packagePlacement } from './package-placement.js';
import { standaloneJsFolders } from './package-placement-js.js';
import type { ManifestReader } from './package-graph-types.js';

type StandaloneInputs = {
  checkEntries: readonly string[];
  commandLines: readonly string[];
  regularFile?: (path: string) => boolean;
};

/** The selection field for one checked head: source read from the verified local cache. Older
 * plans use the same v2 bytes. Incomplete new evidence falls back to ordinary placement. */
export function checkedPackagePlacement(
  paths: Iterable<string>,
  read: ManifestReader,
  standalone?: StandaloneInputs,
) {
  try {
    const pin = standalone
      ? standalonePin([...paths], read, standalone)
      : packagePlacement(buildPackageGraph(paths, read));
    return pin ? { packagePlacement: pin } : {};
  } catch {
    return {};
  }
}

function standalonePin(paths: readonly string[], read: ManifestReader, inputs: StandaloneInputs) {
  let bytes = 0;
  const texts = new Map<string, string | undefined>();
  const graph = buildPackageGraph(paths, path => {
    const text = read(path);
    texts.set(path, text);
    bytes += text === undefined ? 0 : Buffer.byteLength(text);
    return text;
  });
  if (graph.status === 'unknown') return undefined;
  const regular = inputs.regularFile ?? (() => true);
  const verified: ManifestReader = path => {
    if (!regular(path)) return undefined;
    try {
      return read(path);
    } catch {
      return undefined;
    }
  };
  const bounded: ManifestReader = path => {
    if (!regular(path)) return undefined;
    if (!texts.has(path)) {
      const text = verified(path);
      bytes += text === undefined ? 0 : Buffer.byteLength(text);
      texts.set(path, text);
    }
    if (texts.size > PACKAGE_GRAPH_MAX_MANIFESTS || bytes > PACKAGE_GRAPH_MAX_BYTES)
      throw new RangeError('placement input budget exceeded');
    return texts.get(path);
  };
  try {
    const folders = standaloneJsFolders(
      paths,
      bounded,
      graph,
      inputs.checkEntries,
      inputs.commandLines,
      regular,
    );
    return packagePlacement(graph, certifyJsInbound(paths, verified, folders, bounded));
  } catch {
    return packagePlacement(graph);
  }
}
