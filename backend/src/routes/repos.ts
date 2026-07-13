import { Router, Request, Response } from 'express';
import { getNeo4jDriver } from '../services/neo4jService';
import { runIngestion } from '../../../ingestion-worker/src/workflows/ingestRepoWorkflow';

const router = Router();
const driver = getNeo4jDriver();

function toSafeNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
}

// Helper to extract owner/repo from github URL
function parseGithubUrl(url: string): string | null {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;
  const owner = match[1];
  let repo = match[2];
  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }
  return `${owner}/${repo}`;
}

// POST /api/repos - Register repo
router.post('/', async (req: Request, res: Response) => {
  const { repo_url } = req.body;
  if (!repo_url) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'repo_url is required' } });
  }

  const repoId = parseGithubUrl(repo_url);
  if (!repoId) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Invalid GitHub repository URL' } });
  }

  try {
    // Trigger ingestion asynchronously
    runIngestion(repoId).catch(err => {
      console.error(`Background ingestion failed for ${repoId}:`, err);
    });

    return res.status(202).json({
      repo_id: repoId,
      status: 'ingesting',
      registered_at: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: { code: 'server_error', message: error.message } });
  }
});

// GET /api/repos/:owner/:name/status - Poll Ingestion Status
router.get('/:owner/:name/status', async (req: Request, res: Response) => {
  const repoId = `${req.params.owner}/${req.params.name}`;
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Repository { repo_id: $repoId })
       RETURN r`,
      { repoId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ error: { code: 'repo_not_found', message: 'Repository not registered' } });
    }

    const repoNode = result.records[0].get('r').properties;
    
    // Count files and unresolved edges
    const statsRes = await session.run(
      `MATCH (f:File { repo_id: $repoId })
       OPTIONAL MATCH (fn:Function { repo_id: $repoId })
       RETURN count(DISTINCT f) AS files, count(DISTINCT fn) AS functions`,
      { repoId }
    );
    const filesCount = toSafeNumber(statsRes.records[0].get('files'));
    
    return res.status(200).json({
      repo_id: repoId,
      status: repoNode.ingestion_status,
      last_ingested_commit_hash: repoNode.last_ingested_commit_hash || null,
      last_ingested_at: repoNode.last_ingested_at || null,
      file_count: filesCount,
      unresolved_edges_count: repoNode.unresolved_edges_count !== undefined && repoNode.unresolved_edges_count !== null
        ? toSafeNumber(repoNode.unresolved_edges_count)
        : null
    });
  } catch (error: any) {
    console.error('Status check error:', error);
    return res.status(500).json({ error: { code: 'server_error', message: error.message } });
  } finally {
    await session.close();
  }
});

// GET /api/repos/:owner/:name/issues - Fetch open issues
router.get('/:owner/:name/issues', async (req: Request, res: Response) => {
  const repoId = `${req.params.owner}/${req.params.name}`;
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (i:Issue { repo_id: $repoId, state: 'open' })
       RETURN i.number AS number, i.title AS title
       ORDER BY number ASC`,
      { repoId }
    );
    const issues = result.records.map(r => ({
      number: toSafeNumber(r.get('number')),
      title: r.get('title')
    }));
    return res.status(200).json(issues);
  } catch (error: any) {
    console.error('Fetch issues error:', error);
    return res.status(500).json({ error: { code: 'server_error', message: error.message } });
  } finally {
    await session.close();
  }
});

export default router;
