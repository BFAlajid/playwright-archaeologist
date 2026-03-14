/**
 * Flow Graph Builder
 *
 * Takes navigation edges from a crawl and produces:
 * - A FlowGraph with node metadata, cycle detection, and clustering
 * - A Mermaid diagram definition for visualization
 *
 * Used by the Assembler to generate flow diagrams in the HTML report.
 */

import type { NavigationEdge, NavigationTrigger } from '../types/artifacts.js';
import { parameterizePath } from './api-grouper.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface FlowGraphNode {
  url: string;
  /** Short label derived from URL path */
  label: string;
  /** Whether this is the entry point */
  isEntry: boolean;
  /** Whether this is a dead-end (no outgoing edges) */
  isExit: boolean;
  /** Number of incoming edges */
  inDegree: number;
  /** Number of outgoing edges */
  outDegree: number;
  /** Cluster/group based on URL path prefix */
  cluster?: string;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: NavigationEdge[];
  /** Entry URL */
  entryUrl: string;
  /** Whether cycles were detected */
  hasCycles: boolean;
  /** URLs involved in cycles */
  cycleNodes: string[];
  /** Cluster groups (path prefix -> URLs) */
  clusters: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LABEL_LENGTH = 30;
const DEFAULT_MAX_NODES = 50;

// ---------------------------------------------------------------------------
// urlToLabel
// ---------------------------------------------------------------------------

/**
 * Convert a full URL to a short display label.
 * Strips the origin, parameterizes dynamic segments, and truncates.
 */
export function urlToLabel(url: string): string {
  let path: string;
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
  } catch {
    // If it's not a valid URL, treat the whole string as a path
    path = url.split('?')[0];
  }

  if (path === '/' || path === '') {
    return '/';
  }

  // Strip leading slash for the label
  const stripped = path.startsWith('/') ? path.slice(1) : path;

  // Parameterize dynamic segments
  const parameterized = parameterizePath('/' + stripped).slice(1);

  // Truncate if too long
  if (parameterized.length > MAX_LABEL_LENGTH) {
    return parameterized.slice(0, MAX_LABEL_LENGTH - 3) + '...';
  }

  return parameterized;
}

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

/**
 * DFS-based cycle detection.
 * Returns an array of URLs that participate in at least one cycle.
 */
export function detectCycles(edges: NavigationEdge[]): string[] {
  if (edges.length === 0) return [];

  // Build adjacency list
  const adjacency = new Map<string, Set<string>>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    allNodes.add(edge.from);
    allNodes.add(edge.to);
    let neighbors = adjacency.get(edge.from);
    if (!neighbors) {
      neighbors = new Set<string>();
      adjacency.set(edge.from, neighbors);
    }
    neighbors.add(edge.to);
  }

  const cycleNodeSet = new Set<string>();

  // States: 0 = unvisited, 1 = in current path, 2 = fully processed
  const state = new Map<string, 0 | 1 | 2>();
  // Track the current DFS path for extracting cycle participants
  const pathStack: string[] = [];

  function dfs(node: string): void {
    state.set(node, 1);
    pathStack.push(node);

    const neighbors = adjacency.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        const neighborState = state.get(neighbor) ?? 0;

        if (neighborState === 1) {
          // Found a cycle - mark all nodes from the cycle start to current
          const cycleStartIndex = pathStack.indexOf(neighbor);
          if (cycleStartIndex >= 0) {
            for (let i = cycleStartIndex; i < pathStack.length; i++) {
              cycleNodeSet.add(pathStack[i]);
            }
          }
        } else if (neighborState === 0) {
          dfs(neighbor);
        }
      }
    }

    pathStack.pop();
    state.set(node, 2);
  }

  for (const node of allNodes) {
    if ((state.get(node) ?? 0) === 0) {
      dfs(node);
    }
  }

  return Array.from(cycleNodeSet);
}

// ---------------------------------------------------------------------------
// clusterByPathPrefix
// ---------------------------------------------------------------------------

/**
 * Group URLs by their first path segment.
 * e.g., /api/users, /api/posts -> cluster "api"
 *       /docs/intro -> cluster "docs"
 *       / -> cluster "/"
 */
export function clusterByPathPrefix(urls: string[]): Map<string, string[]> {
  const clusters = new Map<string, string[]>();

  for (const url of urls) {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url.split('?')[0];
    }

    // Extract first path segment
    const segments = path.split('/').filter(Boolean);
    const prefix = segments.length > 0 ? segments[0] : '/';

    let group = clusters.get(prefix);
    if (!group) {
      group = [];
      clusters.set(prefix, group);
    }
    group.push(url);
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// buildFlowGraph
// ---------------------------------------------------------------------------

/**
 * Build a FlowGraph from navigation edges and an entry URL.
 * Deduplicates edges, computes node metadata, detects cycles, and clusters URLs.
 */
export function buildFlowGraph(edges: NavigationEdge[], entryUrl: string): FlowGraph {
  // Deduplicate edges by (from, to, trigger)
  const edgeKeys = new Set<string>();
  const dedupedEdges: NavigationEdge[] = [];

  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}\0${edge.trigger}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      dedupedEdges.push(edge);
    }
  }

  // Collect all unique URLs
  const urlSet = new Set<string>();
  urlSet.add(entryUrl);
  for (const edge of dedupedEdges) {
    urlSet.add(edge.from);
    urlSet.add(edge.to);
  }

  // Compute in-degree and out-degree
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const url of urlSet) {
    inDegree.set(url, 0);
    outDegree.set(url, 0);
  }
  for (const edge of dedupedEdges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
  }

  // Detect cycles
  const cycleNodes = detectCycles(dedupedEdges);
  const hasCycles = cycleNodes.length > 0;

  // Cluster by path prefix
  const allUrls = Array.from(urlSet);
  const clusters = clusterByPathPrefix(allUrls);

  // Build URL-to-cluster lookup
  const urlToCluster = new Map<string, string>();
  for (const [prefix, urls] of clusters) {
    for (const url of urls) {
      urlToCluster.set(url, prefix);
    }
  }

  // Build nodes
  const nodes: FlowGraphNode[] = allUrls.map((url) => ({
    url,
    label: urlToLabel(url),
    isEntry: url === entryUrl,
    isExit: (outDegree.get(url) ?? 0) === 0,
    inDegree: inDegree.get(url) ?? 0,
    outDegree: outDegree.get(url) ?? 0,
    cluster: urlToCluster.get(url),
  }));

  return {
    nodes,
    edges: dedupedEdges,
    entryUrl,
    hasCycles,
    cycleNodes,
    clusters,
  };
}

// ---------------------------------------------------------------------------
// generateMermaidDefinition
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a Mermaid node label.
 * Escapes quotes and brackets that break Mermaid syntax.
 */
function sanitizeMermaidLabel(label: string): string {
  return label
    .replace(/"/g, '#quot;')
    .replace(/\[/g, '#lsqb;')
    .replace(/\]/g, '#rsqb;')
    .replace(/\(/g, '#lpar;')
    .replace(/\)/g, '#rpar;')
    .replace(/\{/g, '#lcub;')
    .replace(/\}/g, '#rcub;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

/**
 * Create a stable node ID from a URL for use in Mermaid definitions.
 */
function nodeId(url: string, index: number): string {
  return `N${index}`;
}

/**
 * Get the Mermaid edge style for a navigation trigger.
 * - Solid (-->) for link, click, form-submit
 * - Dashed (-.->) for redirect, meta-refresh, js-redirect
 * - Dotted (-.->)  for pushState, replaceState, navigation-api
 */
function edgeStyle(trigger: NavigationTrigger): string {
  switch (trigger) {
    case 'link':
    case 'click':
    case 'form-submit':
      return '-->';
    case 'redirect':
    case 'meta-refresh':
    case 'js-redirect':
      return '-.->';
    case 'pushState':
    case 'replaceState':
    case 'navigation-api':
      return '-.->';
    default:
      return '-->';
  }
}

/**
 * Generate a Mermaid flowchart definition from a FlowGraph.
 *
 * If the graph exceeds maxNodes (default 50), URLs are auto-clustered
 * by first path segment and rendered as Mermaid subgraphs.
 */
export function generateMermaidDefinition(
  graph: FlowGraph,
  options?: { maxNodes?: number },
): string {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;

  if (graph.nodes.length === 0) {
    return 'flowchart LR\n';
  }

  // Build URL -> index mapping for stable node IDs
  const urlIndex = new Map<string, number>();
  graph.nodes.forEach((node, i) => {
    urlIndex.set(node.url, i);
  });

  const lines: string[] = ['flowchart LR'];

  const useSubgraphs = graph.nodes.length > maxNodes;

  if (useSubgraphs) {
    // Group nodes by cluster
    const clusterNodes = new Map<string, FlowGraphNode[]>();
    for (const node of graph.nodes) {
      const cluster = node.cluster ?? '/';
      let group = clusterNodes.get(cluster);
      if (!group) {
        group = [];
        clusterNodes.set(cluster, group);
      }
      group.push(node);
    }

    for (const [cluster, nodes] of clusterNodes) {
      const sanitizedCluster = sanitizeMermaidLabel(cluster);
      lines.push(`  subgraph ${sanitizedCluster}`);
      for (const node of nodes) {
        const id = nodeId(node.url, urlIndex.get(node.url)!);
        const label = sanitizeMermaidLabel(node.label);
        if (node.isEntry) {
          lines.push(`    ${id}(["${label}"])`);
        } else if (node.isExit) {
          lines.push(`    ${id}[/"${label}"/]`);
        } else {
          lines.push(`    ${id}["${label}"]`);
        }
      }
      lines.push('  end');
    }
  } else {
    // Flat node declarations
    for (const node of graph.nodes) {
      const id = nodeId(node.url, urlIndex.get(node.url)!);
      const label = sanitizeMermaidLabel(node.label);
      if (node.isEntry) {
        lines.push(`  ${id}(["${label}"])`);
      } else if (node.isExit) {
        lines.push(`  ${id}[/"${label}"/]`);
      } else {
        lines.push(`  ${id}["${label}"]`);
      }
    }
  }

  // Edge declarations
  for (const edge of graph.edges) {
    const fromIdx = urlIndex.get(edge.from);
    const toIdx = urlIndex.get(edge.to);
    if (fromIdx === undefined || toIdx === undefined) continue;

    const fromId = nodeId(edge.from, fromIdx);
    const toId = nodeId(edge.to, toIdx);
    const style = edgeStyle(edge.trigger);
    const triggerLabel = edge.triggerText
      ? ` |${sanitizeMermaidLabel(edge.triggerText)}|`
      : '';

    lines.push(`  ${fromId} ${style}${triggerLabel} ${toId}`);
  }

  return lines.join('\n') + '\n';
}
