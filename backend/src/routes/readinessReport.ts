import { Router, Request, Response } from 'express';
import { getNeo4jDriver } from '../services/neo4jService';
import {
  computeExplorationCoverage,
  computeEvidenceCoverage,
  computeDependencyCoverage,
  getReviewerRecommendation,
  identifySeeds
} from '../metrics/coverage';

const router = Router();
const driver = getNeo4jDriver();

// GET /api/reports/readiness
router.get('/', async (req: Request, res: Response) => {
  const repoId = req.query.repo_id as string;
  const issueNumber = Number(req.query.issue_number);
  const prNumber = req.query.pr_number ? Number(req.query.pr_number) : undefined;
  const contributorId = 'contributor_user'; // default active contributor

  if (!repoId || !issueNumber) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'repo_id and issue_number are required' } });
  }

  const session = driver.session();
  try {
    // 1. Fetch Repository Info
    const repoRes = await session.run(
      `MATCH (r:Repository { repo_id: $repoId })
       RETURN r.last_ingested_commit_hash AS commitHash`,
      { repoId }
    );
    if (repoRes.records.length === 0) {
      return res.status(404).json({ error: { code: 'repo_not_found', message: 'Repository not registered' } });
    }
    const commitHash = repoRes.records[0].get('commitHash') || 'unknown';

    // 2. Compute Coverage Metrics
    const exploration_coverage = await computeExplorationCoverage(repoId, issueNumber, contributorId);
    const evidence_coverage = await computeEvidenceCoverage(repoId, issueNumber, contributorId);
    const dependency_coverage = await computeDependencyCoverage(repoId, issueNumber, contributorId, prNumber);

    // 3. Identify Missing Critical Nodes
    // Find subgraph nodes (seeds + 2-hop dependencies)
    const { paths: seeds } = await identifySeeds(repoId, issueNumber);
    
    const missingNodes: { name: string; reason: string }[] = [];
    if (seeds.length > 0) {
      const missingRes = await session.run(
        `MATCH (seed:File { repo_id: $repoId })
         WHERE seed.path IN $seeds
         CALL apoc.path.subgraphAll(seed, {
           relationshipFilter: 'IMPORTS>|CALLS>|DEPENDS_ON>',
           minLevel: 0,
           maxLevel: 2
         }) YIELD nodes
         UNWIND nodes AS node
         WITH node, seed
         // External package stub nodes are never a real, citable contribution
         // target — exclude them, same as Learning Path and seed identification do.
         WHERE NOT node:ExternalPackage
         // Filter out nodes already explored (cited in Q&A)
         AND NOT exists {
           MATCH (u:Contributor { github_login: $contributorId })-[:ASKED]->(q:Query)-[:CITES]->(node)
         }
         RETURN node, labels(node) AS labels, seed.path AS seedPath LIMIT 3`,
        { repoId, seeds, contributorId }
      );

      missingRes.records.forEach(r => {
        const node = r.get('node').properties;
        const labels = r.get('labels');
        const seedPath = r.get('seedPath');
        const isFile = labels.includes('File');
        const name = isFile ? node.path : node.name;
        const typeStr = isFile ? 'File' : 'Function';

        missingNodes.push({
          name,
          reason: `${typeStr} — required because it is in the dependency path of seed node '${seedPath}' for Issue #${issueNumber} but has not been cited in any explored evidence answers.`
        });
      });
    }

    // 4. Suggested Reviewer Recommendation
    // Touch files: either PR files or issue seeds
    let targetFiles = seeds;
    if (prNumber) {
      const prFilesRes = await session.run(
        `MATCH (p:PullRequest { repo_id: $repoId, number: $prNumber })
         MATCH (c:Commit)-[:PART_OF]->(p)
         MATCH (c)-[:MODIFIES]->(f:File)
         RETURN DISTINCT f.path AS path`,
        { repoId, prNumber }
      );
      if (prFilesRes.records.length > 0) {
        targetFiles = prFilesRes.records.map(r => r.get('path'));
      }
    }

    const { candidates: reviewers, candidate_pool_size } = await getReviewerRecommendation(repoId, targetFiles, issueNumber);
    const suggestedReviewer = reviewers && reviewers.length > 0
      ? { login: reviewers[0].login, score: reviewers[0].score }
      : null;

    return res.status(200).json({
      issue_number: issueNumber,
      generated_at: new Date().toISOString(),
      repo_commit_hash: commitHash,
      exploration_coverage: parseFloat(exploration_coverage.toFixed(2)),
      evidence_coverage: parseFloat(evidence_coverage.toFixed(2)),
      dependency_coverage: parseFloat(dependency_coverage.toFixed(2)),
      missing_critical_nodes: missingNodes,
      suggested_reviewer: suggestedReviewer,
      candidate_pool_size
    });
  } catch (error: any) {
    console.error('Readiness report error:', error);
    return res.status(500).json({ error: { code: 'server_error', message: error.message } });
  } finally {
    await session.close();
  }
});

export default router;
