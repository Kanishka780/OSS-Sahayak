import { Router, Request, Response } from 'express';
import { getNeo4jDriver } from '../services/neo4jService';
import { identifySeeds } from '../metrics/coverage';
import { LearningPathStep } from 'shared';

const router = Router();
const driver = getNeo4jDriver();

// Cycle-safe topological sort (ignoring back-edges to avoid throwing)
function topologicalSort(nodes: any[], edges: { from: string; to: string }[]): string[] {
  const adj: Record<string, string[]> = {};
  const inDegree: Record<string, number> = {};

  for (const node of nodes) {
    adj[node.id] = [];
    inDegree[node.id] = 0;
  }

  for (const edge of edges) {
    if (adj[edge.from] && adj[edge.to]) {
      adj[edge.from].push(edge.to);
      inDegree[edge.to]++;
    }
  }

  const queue: string[] = [];
  for (const nodeId of Object.keys(inDegree)) {
    if (inDegree[nodeId] === 0) {
      queue.push(nodeId);
    }
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    result.push(curr);

    for (const neighbor of adj[curr]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Handle any nodes remaining in cycle
  for (const nodeId of Object.keys(inDegree)) {
    if (!result.includes(nodeId)) {
      result.push(nodeId); // fallback: just append remaining cyclic nodes
    }
  }

  return result;
}

// GET /api/learning-path
router.get('/', async (req: Request, res: Response) => {
  const repoId = req.query.repo_id as string;
  const issueNumber = Number(req.query.issue_number);

  if (!repoId || !issueNumber) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'repo_id and issue_number are required' } });
  }

  const session = driver.session();
  try {
    // 1. Identify Seed Nodes
    const { paths: seeds, method: seedMethod } = await identifySeeds(repoId, issueNumber);
    if (seeds.length === 0) {
      return res.status(200).json({
        issue_number: issueNumber,
        path: [],
        seed_method: null,
        low_confidence: true,
        reason: 'no_seed_nodes_identified'
      });
    }

    // 2. Expand Seeds to Subgraph (depth 2)
    const result = await session.run(
      `MATCH (seed:File { repo_id: $repoId })
       WHERE seed.path IN $seeds
       CALL apoc.path.subgraphAll(seed, {
         relationshipFilter: 'IMPORTS>|CALLS>|DEPENDS_ON>',
         minLevel: 0,
         maxLevel: 2
       }) YIELD nodes, relationships
       RETURN nodes, relationships`,
      { repoId, seeds }
    );

    if (result.records.length === 0) {
      return res.status(200).json({
        issue_number: issueNumber,
        path: [],
        seed_method: seedMethod,
        low_confidence: seedMethod === 'centrality_fallback_low_confidence'
      });
    }

    const records = result.records[0];
    const neoNodes = records.get('nodes') || [];
    const neoRels = records.get('relationships') || [];

    const nodes = neoNodes.map((n: any) => {
      const isExternal = n.labels.includes('ExternalPackage');
      const isFile = n.labels.includes('File');
      return {
        id: isFile ? n.properties.path : n.properties.function_id,
        type: isExternal ? 'ExternalPackage' : (isFile ? 'File' : 'Function'),
        name: n.properties.name || n.properties.path,
      };
    });

    const edges: { from: string; to: string }[] = [];
    neoRels.forEach((r: any) => {
      // Find start and end nodes
      const startNode = neoNodes.find((n: any) => n.elementId === r.startNodeElementId);
      const endNode = neoNodes.find((n: any) => n.elementId === r.endNodeElementId);
      if (startNode && endNode) {
        const fromId = startNode.labels.includes('File') ? startNode.properties.path : startNode.properties.function_id;
        const toId = endNode.labels.includes('File') ? endNode.properties.path : endNode.properties.function_id;
        edges.push({ from: fromId, to: toId });
      }
    });

    // 3. Topological Sort
    const sortedIds = topologicalSort(nodes, edges);

    // 4. Build sequenced output steps
    const filteredNodes = sortedIds
      .map(id => nodes.find((n: any) => n.id === id)!)
      .filter((n: any) => n && n.type !== 'ExternalPackage');

    const pathSteps: LearningPathStep[] = filteredNodes.map((node, index) => {
      const isSeed = seeds.includes(node.id);
      
      let action: 'read' | 'understand' | 'edit' = 'read';
      if (isSeed) {
        action = 'edit';
      } else if (node.type === 'Function') {
        action = 'understand';
      }

      return {
        step: index + 1,
        type: node.type as 'File' | 'Function',
        id: node.id,
        action,
      };
    });

    return res.status(200).json({
      issue_number: issueNumber,
      path: pathSteps,
      seed_method: seedMethod,
      low_confidence: seedMethod === 'centrality_fallback_low_confidence'
    });
  } catch (error: any) {
    console.error('Learning path error:', error);
    return res.status(500).json({ error: { code: 'server_error', message: error.message } });
  } finally {
    await session.close();
  }
});

export default router;
