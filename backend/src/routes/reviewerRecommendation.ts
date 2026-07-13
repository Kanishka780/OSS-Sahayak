import { Router, Request, Response } from 'express';
import { getReviewerRecommendation } from '../metrics/coverage';

const router = Router();

// GET /api/reviewer-recommendation
router.get('/', async (req: Request, res: Response) => {
  const repoId = req.query.repo_id as string;
  let filePaths = req.query.file_paths as string | string[];
  const issueNumberStr = req.query.issue_number as string;
  const issueNumber = issueNumberStr ? Number(issueNumberStr) : 0;

  if (!repoId || !filePaths) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'repo_id and file_paths are required' } });
  }

  // Ensure filePaths is an array of strings
  if (!Array.isArray(filePaths)) {
    filePaths = [filePaths];
  }

  try {
    const { candidates, candidate_pool_size } = await getReviewerRecommendation(repoId, filePaths, issueNumber);
    return res.status(200).json({ candidates, candidate_pool_size });
  } catch (error: any) {
    console.error('Reviewer recommendation error:', error);
    return res.status(500).json({ error: { code: 'server_error', message: error.message } });
  }
});

export default router;
