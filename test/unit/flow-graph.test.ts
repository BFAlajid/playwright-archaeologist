/**
 * Unit tests for src/assembler/flow-graph.ts
 *
 * Flow graph construction, cycle detection, URL clustering,
 * Mermaid diagram generation, and label formatting.
 */

import { describe, it, expect } from 'vitest';
import type { NavigationEdge, NavigationTrigger } from '../../src/types/artifacts.js';
import {
  buildFlowGraph,
  generateMermaidDefinition,
  detectCycles,
  clusterByPathPrefix,
  urlToLabel,
} from '../../src/assembler/flow-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function edge(
  from: string,
  to: string,
  trigger: NavigationTrigger = 'link',
  triggerText?: string,
): NavigationEdge {
  return { from, to, trigger, triggerText };
}

const A = 'https://example.com/';
const B = 'https://example.com/about';
const C = 'https://example.com/contact';
const D = 'https://example.com/api/users';
const E = 'https://example.com/api/posts';
const F = 'https://example.com/docs/intro';

// ---------------------------------------------------------------------------
// buildFlowGraph
// ---------------------------------------------------------------------------

describe('buildFlowGraph', () => {
  it('builds graph from simple edges (A -> B -> C)', () => {
    const edges = [edge(A, B), edge(B, C)];
    const graph = buildFlowGraph(edges, A);

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.entryUrl).toBe(A);
  });

  it('detects entry and exit nodes', () => {
    const edges = [edge(A, B), edge(B, C)];
    const graph = buildFlowGraph(edges, A);

    const entryNode = graph.nodes.find((n) => n.url === A);
    const exitNode = graph.nodes.find((n) => n.url === C);
    const middleNode = graph.nodes.find((n) => n.url === B);

    expect(entryNode?.isEntry).toBe(true);
    expect(entryNode?.isExit).toBe(false);
    expect(exitNode?.isEntry).toBe(false);
    expect(exitNode?.isExit).toBe(true);
    expect(middleNode?.isEntry).toBe(false);
    expect(middleNode?.isExit).toBe(false);
  });

  it('handles empty edges', () => {
    const graph = buildFlowGraph([], A);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(graph.hasCycles).toBe(false);
    expect(graph.cycleNodes).toHaveLength(0);

    const entryNode = graph.nodes[0];
    expect(entryNode.url).toBe(A);
    expect(entryNode.isEntry).toBe(true);
    expect(entryNode.isExit).toBe(true);
  });

  it('handles single node (entry only, no edges)', () => {
    const graph = buildFlowGraph([], A);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].isEntry).toBe(true);
    expect(graph.nodes[0].isExit).toBe(true);
    expect(graph.nodes[0].inDegree).toBe(0);
    expect(graph.nodes[0].outDegree).toBe(0);
  });

  it('deduplicates edges with same from/to/trigger', () => {
    const edges = [
      edge(A, B, 'link'),
      edge(A, B, 'link'),
      edge(A, B, 'link'),
    ];
    const graph = buildFlowGraph(edges, A);

    expect(graph.edges).toHaveLength(1);
  });

  it('keeps edges with different triggers as separate', () => {
    const edges = [
      edge(A, B, 'link'),
      edge(A, B, 'redirect'),
    ];
    const graph = buildFlowGraph(edges, A);

    expect(graph.edges).toHaveLength(2);
  });

  it('computes in/out degree counts correctly', () => {
    // A -> B, A -> C, B -> C
    const edges = [edge(A, B), edge(A, C), edge(B, C)];
    const graph = buildFlowGraph(edges, A);

    const nodeA = graph.nodes.find((n) => n.url === A)!;
    const nodeB = graph.nodes.find((n) => n.url === B)!;
    const nodeC = graph.nodes.find((n) => n.url === C)!;

    expect(nodeA.outDegree).toBe(2);
    expect(nodeA.inDegree).toBe(0);

    expect(nodeB.outDegree).toBe(1);
    expect(nodeB.inDegree).toBe(1);

    expect(nodeC.outDegree).toBe(0);
    expect(nodeC.inDegree).toBe(2);
  });

  it('handles edges with all trigger types', () => {
    const triggers: NavigationTrigger[] = [
      'link', 'form-submit', 'redirect', 'pushState', 'replaceState',
      'navigation-api', 'click', 'meta-refresh', 'js-redirect',
    ];

    const edges = triggers.map((trigger, i) =>
      edge(A, `https://example.com/page${i}`, trigger),
    );

    const graph = buildFlowGraph(edges, A);

    expect(graph.edges).toHaveLength(triggers.length);
    expect(graph.nodes).toHaveLength(triggers.length + 1); // A + all targets
  });

  it('populates clusters on nodes', () => {
    const edges = [edge(A, D), edge(A, F)];
    const graph = buildFlowGraph(edges, A);

    const apiNode = graph.nodes.find((n) => n.url === D)!;
    const docsNode = graph.nodes.find((n) => n.url === F)!;

    expect(apiNode.cluster).toBe('api');
    expect(docsNode.cluster).toBe('docs');
  });
});

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

describe('detectCycles', () => {
  it('detects simple cycle (A -> B -> A)', () => {
    const edges = [edge(A, B), edge(B, A)];
    const result = detectCycles(edges);

    expect(result).toContain(A);
    expect(result).toContain(B);
  });

  it('detects longer cycle (A -> B -> C -> A)', () => {
    const edges = [edge(A, B), edge(B, C), edge(C, A)];
    const result = detectCycles(edges);

    expect(result).toContain(A);
    expect(result).toContain(B);
    expect(result).toContain(C);
  });

  it('returns empty array for acyclic graph', () => {
    const edges = [edge(A, B), edge(B, C)];
    const result = detectCycles(edges);

    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty edges', () => {
    const result = detectCycles([]);
    expect(result).toHaveLength(0);
  });

  it('detects self-loop', () => {
    const edges = [edge(A, A)];
    const result = detectCycles(edges);

    expect(result).toContain(A);
  });

  it('detects cycle in subgraph while other nodes are acyclic', () => {
    // A -> B -> C (acyclic), D -> E -> D (cycle)
    const edges = [
      edge(A, B), edge(B, C),
      edge(D, E), edge(E, D),
    ];
    const result = detectCycles(edges);

    expect(result).toContain(D);
    expect(result).toContain(E);
    expect(result).not.toContain(A);
    expect(result).not.toContain(B);
    expect(result).not.toContain(C);
  });
});

// ---------------------------------------------------------------------------
// clusterByPathPrefix
// ---------------------------------------------------------------------------

describe('clusterByPathPrefix', () => {
  it('groups URLs by first path segment', () => {
    const urls = [D, E, F];
    const clusters = clusterByPathPrefix(urls);

    expect(clusters.get('api')).toEqual(
      expect.arrayContaining([D, E]),
    );
    expect(clusters.get('docs')).toEqual([F]);
  });

  it('groups root URL under "/" cluster', () => {
    const clusters = clusterByPathPrefix([A]);
    expect(clusters.has('/')).toBe(true);
    expect(clusters.get('/')!).toContain(A);
  });

  it('handles single URL', () => {
    const clusters = clusterByPathPrefix([D]);
    expect(clusters.size).toBe(1);
    expect(clusters.get('api')).toEqual([D]);
  });

  it('handles empty array', () => {
    const clusters = clusterByPathPrefix([]);
    expect(clusters.size).toBe(0);
  });

  it('groups URLs with different path depths under same prefix', () => {
    const urls = [
      'https://example.com/api/users',
      'https://example.com/api/users/123',
      'https://example.com/api/posts/456/comments',
    ];
    const clusters = clusterByPathPrefix(urls);

    expect(clusters.get('api')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// urlToLabel
// ---------------------------------------------------------------------------

describe('urlToLabel', () => {
  it('returns "/" for root URL', () => {
    expect(urlToLabel('https://example.com/')).toBe('/');
  });

  it('strips origin and leading slash', () => {
    expect(urlToLabel('https://example.com/about')).toBe('about');
  });

  it('parameterizes numeric IDs', () => {
    expect(urlToLabel('https://example.com/api/users/123')).toBe('api/users/:id');
  });

  it('truncates long labels to 30 chars', () => {
    const longUrl = 'https://example.com/very/long/deeply/nested/path/segment/here';
    const label = urlToLabel(longUrl);
    expect(label.length).toBeLessThanOrEqual(30);
    expect(label.endsWith('...')).toBe(true);
  });

  it('handles URL with query string', () => {
    const label = urlToLabel('https://example.com/search?q=test');
    expect(label).toBe('search');
  });

  it('handles multi-segment paths', () => {
    expect(urlToLabel('https://example.com/api/users')).toBe('api/users');
  });

  it('handles path-only strings', () => {
    expect(urlToLabel('/api/users')).toBe('api/users');
  });
});

// ---------------------------------------------------------------------------
// generateMermaidDefinition
// ---------------------------------------------------------------------------

describe('generateMermaidDefinition', () => {
  it('generates valid Mermaid definition', () => {
    const edges = [edge(A, B), edge(B, C)];
    const graph = buildFlowGraph(edges, A);
    const mermaid = generateMermaidDefinition(graph);

    expect(mermaid).toContain('flowchart LR');
    // Should have node declarations
    expect(mermaid).toContain('N0');
    expect(mermaid).toContain('N1');
    expect(mermaid).toContain('N2');
    // Should have edge declarations with -->
    expect(mermaid).toContain('-->');
  });

  it('returns minimal definition for empty graph', () => {
    const graph = buildFlowGraph([], A);
    // Entry node is still present
    const mermaid = generateMermaidDefinition(graph);

    expect(mermaid).toContain('flowchart LR');
    expect(mermaid).toContain('N0');
  });

  it('uses stadium shape for entry node', () => {
    const graph = buildFlowGraph([edge(A, B)], A);
    const mermaid = generateMermaidDefinition(graph);

    // Entry nodes use (["label"]) stadium shape
    expect(mermaid).toMatch(/N\d+\(\["/);
  });

  it('uses trapezoid shape for exit node', () => {
    const graph = buildFlowGraph([edge(A, B)], A);
    const mermaid = generateMermaidDefinition(graph);

    // Exit nodes use [/"label"/] trapezoid shape
    expect(mermaid).toMatch(/N\d+\[\//);
  });

  it('uses solid arrow for link edges', () => {
    const graph = buildFlowGraph([edge(A, B, 'link')], A);
    const mermaid = generateMermaidDefinition(graph);

    expect(mermaid).toContain('-->');
  });

  it('uses dashed arrow for redirect edges', () => {
    const graph = buildFlowGraph([edge(A, B, 'redirect')], A);
    const mermaid = generateMermaidDefinition(graph);

    expect(mermaid).toContain('-.->');
  });

  it('uses dashed arrow for pushState edges', () => {
    const graph = buildFlowGraph([edge(A, B, 'pushState')], A);
    const mermaid = generateMermaidDefinition(graph);

    expect(mermaid).toContain('-.->');
  });

  it('includes trigger text as edge label', () => {
    const graph = buildFlowGraph(
      [edge(A, B, 'link', 'About Us')],
      A,
    );
    const mermaid = generateMermaidDefinition(graph);

    expect(mermaid).toContain('About Us');
  });

  it('uses subgraphs when nodes exceed maxNodes', () => {
    // Create graph with 3 nodes and maxNodes=2
    const edges = [edge(A, B), edge(B, C)];
    const graph = buildFlowGraph(edges, A);
    const mermaid = generateMermaidDefinition(graph, { maxNodes: 2 });

    expect(mermaid).toContain('subgraph');
    expect(mermaid).toContain('end');
  });

  it('does not use subgraphs when nodes are under maxNodes', () => {
    const edges = [edge(A, B)];
    const graph = buildFlowGraph(edges, A);
    const mermaid = generateMermaidDefinition(graph, { maxNodes: 50 });

    expect(mermaid).not.toContain('subgraph');
  });

  it('sanitizes special characters in labels', () => {
    const specialUrl = 'https://example.com/page[1]';
    const edges = [edge(A, specialUrl)];
    const graph = buildFlowGraph(edges, A);
    const mermaid = generateMermaidDefinition(graph);

    // Brackets should be escaped
    expect(mermaid).not.toMatch(/\["[^"]*\[/);
    expect(mermaid).toContain('#lsqb;');
  });

  it('handles graph with no edges (single entry node)', () => {
    const graph = buildFlowGraph([], A);
    const mermaid = generateMermaidDefinition(graph);

    expect(mermaid).toContain('flowchart LR');
    // Entry node with stadium shape
    expect(mermaid).toMatch(/N0\(\["/);
  });
});
