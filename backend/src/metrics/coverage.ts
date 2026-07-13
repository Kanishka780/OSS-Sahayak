import { getNeo4jDriver } from '../services/neo4jService';
import { ReviewerCandidate, EvidenceLink } from 'shared';

const driver = getNeo4jDriver();

function toSafeNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
}

// 1. Identify seed nodes for an issue based on the fallback hierarchy
export async function identifySeeds(repoId: string, issueNumber: number): Promise<{ paths: string[]; method: string }> {
  const session = driver.session();
  try {
    // Tier A: Explicit mentions
    const tierA = await session.run(
      `MATCH (i:Issue { repo_id: $repoId, number: $issueNumber })-[ref:REFERENCES]->(seed)
       WHERE seed:File OR seed:Function
       RETURN DISTINCT case when seed:File then seed.path else seed.file_path end AS path, ref.confidence AS conf
       ORDER BY conf DESC`,
      { repoId, issueNumber }
    );
    if (tierA.records.length > 0) {
      return {
        paths: tierA.records.map(r => r.get('path')),
        method: 'explicit_mention',
      };
    }

    // Tier B: Label-matched historical fixes
    const tierB = await session.run(
      `MATCH (i:Issue { repo_id: $repoId, number: $issueNumber })
       MATCH (past:Issue { repo_id: $repoId })
         WHERE past.number <> i.number
           AND any(l IN past.labels WHERE l IN i.labels)
           AND past.state = 'closed'
       MATCH (pr:PullRequest)-[:RESOLVES]->(past)
       MATCH (c:Commit)-[:PART_OF]->(pr)
       MATCH (c)-[:MODIFIES]->(f:File)
       RETURN f.path AS path, count(DISTINCT c) AS touch_count
       ORDER BY touch_count DESC
       LIMIT 5`,
      { repoId, issueNumber }
    );
    if (tierB.records.length > 0) {
      return {
        paths: tierB.records.map(r => r.get('path')),
        method: 'label_matched_historical_fix',
      };
    }

    // Tier C: Frequently-modified-files-by-label
    const tierC = await session.run(
      `MATCH (i:Issue { repo_id: $repoId, number: $issueNumber })
       MATCH (other:Issue { repo_id: $repoId })
         WHERE any(l IN other.labels WHERE l IN i.labels)
       MATCH (pr:PullRequest)-[:RESOLVES]->(other)
       MATCH (c:Commit)-[:PART_OF]->(pr)-[:MODIFIES]->(f:File)
       RETURN f.path AS path, count(c) AS modification_frequency
       ORDER BY modification_frequency DESC
       LIMIT 5`,
      { repoId, issueNumber }
    );
    if (tierC.records.length > 0) {
      return {
        paths: tierC.records.map(r => r.get('path')),
        method: 'frequent_by_label',
      };
    }

    // Tier D: Centrality fallback (marked low-confidence)
    const tierD = await session.run(
      `MATCH (f:File { repo_id: $repoId })
       WHERE NOT f:ExternalPackage
       RETURN f.path AS path, f.in_degree_centrality AS centrality
       ORDER BY centrality DESC
       LIMIT 5`,
      { repoId }
    );
    return {
      paths: tierD.records.map(r => r.get('path')),
      method: 'centrality_fallback_low_confidence',
    };
  } finally {
    await session.close();
  }
}

// 2. Compute Exploration Coverage
export async function computeExplorationCoverage(
  repoId: string,
  issueNumber: number,
  contributorId: string
): Promise<number> {
  const session = driver.session();
  try {
    const { paths: seeds } = await identifySeeds(repoId, issueNumber);
    if (seeds.length === 0) return 0;

    // Fetch the dependency subgraph (depth 2) from seed nodes
    const subgraphRes = await session.run(
      `MATCH (seed:File { repo_id: $repoId })
       WHERE seed.path IN $seeds
       CALL apoc.path.subgraphAll(seed, {
         relationshipFilter: 'IMPORTS>|CALLS>|DEPENDS_ON>',
         minLevel: 0,
         maxLevel: 2
       }) YIELD nodes
       UNWIND nodes AS node
       RETURN DISTINCT 
              id(node) AS nodeId, 
              node.in_degree_centrality AS weight, 
              labels(node) AS labels,
              case when node:File then node.path else node.function_id end AS identifier`,
      { repoId, seeds }
    );

    if (subgraphRes.records.length === 0) return 0;

    // Get the explored nodes by this contributor
    const exploredRes = await session.run(
      `MATCH (u:Contributor { github_login: $contributorId })-[:ASKED]->(q:Query)-[:CITES]->(explored)
       WHERE (explored:File OR explored:Function) AND explored.repo_id = $repoId
       RETURN DISTINCT id(explored) AS nodeId`,
      { contributorId, repoId }
    );
    const exploredNodeIds = new Set(exploredRes.records.map(r => toSafeNumber(r.get('nodeId'))));

    let totalWeight = 0;
    let exploredWeight = 0;

    subgraphRes.records.forEach(r => {
      const nodeId = toSafeNumber(r.get('nodeId'));
      const weight = r.get('weight') ? parseFloat(r.get('weight')) : 0;
      totalWeight += weight;
      if (exploredNodeIds.has(nodeId)) {
        exploredWeight += weight;
      }
    });

    if (totalWeight === 0) return 1.0; // avoid division-by-zero, return 100% exploration of a 0-weight subgraph
    return exploredWeight / totalWeight;
  } catch (err) {
    console.error('Exploration Coverage computation failed:', err);
    return 0;
  } finally {
    await session.close();
  }
}

// 3. Compute Evidence Coverage
export async function computeEvidenceCoverage(
  repoId: string,
  issueNumber: number,
  contributorId: string
): Promise<number> {
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH (u:Contributor { github_login: $contributorId })-[:ASKED]->(q:Query)
       WITH count(q) AS total, sum(case when q.refusal = false then 1 else 0 end) AS evidenceCount
       RETURN total, evidenceCount`,
      { contributorId }
    );
    if (res.records.length === 0) return 0;
    
    const record = res.records[0];
    const total = toSafeNumber(record.get('total'));
    const evidenceCount = toSafeNumber(record.get('evidenceCount'));

    if (total === 0) return 0;
    return evidenceCount / total;
  } catch (err) {
    console.error('Evidence Coverage computation failed:', err);
    return 0;
  } finally {
    await session.close();
  }
}

// 4. Compute Dependency Coverage
export async function computeDependencyCoverage(
  repoId: string,
  issueNumber: number,
  contributorId: string,
  prNumber?: number
): Promise<number> {
  const session = driver.session();
  try {
    let targetFiles: string[] = [];

    if (prNumber) {
      // Get files modified in this PR
      const filesRes = await session.run(
        `MATCH (p:PullRequest { repo_id: $repoId, number: $prNumber })
         MATCH (c:Commit)-[:PART_OF]->(p)
         MATCH (c)-[:MODIFIES]->(f:File)
         RETURN DISTINCT f.path AS path`,
        { repoId, prNumber }
      );
      targetFiles = filesRes.records.map(r => r.get('path'));
    }

    // Fallback to seeds if no PR files found
    if (targetFiles.length === 0) {
      const { paths: seeds } = await identifySeeds(repoId, issueNumber);
      targetFiles = seeds;
    }

    if (targetFiles.length === 0) return 0;

    // Fetch depth-2 blast radius (direction-agnostic expansion)
    const blastRes = await session.run(
      `MATCH (origin:File { repo_id: $repoId })
       WHERE origin.path IN $targetFiles
       CALL apoc.path.subgraphAll(origin, {
         relationshipFilter: 'IMPORTS|CALLS|DEPENDS_ON',
         minLevel: 0,
         maxLevel: 2
       }) YIELD nodes
       UNWIND nodes AS node
       RETURN DISTINCT id(node) AS nodeId`,
      { repoId, targetFiles }
    );

    if (blastRes.records.length === 0) return 0;

    const blastNodeIds = blastRes.records.map(r => toSafeNumber(r.get('nodeId')));

    // Get explored nodes
    const exploredRes = await session.run(
      `MATCH (u:Contributor { github_login: $contributorId })-[:ASKED]->(q:Query)-[:CITES]->(explored)
       WHERE (explored:File OR explored:Function) AND explored.repo_id = $repoId
       RETURN DISTINCT id(explored) AS nodeId`,
      { contributorId, repoId }
    );
    const exploredNodeIds = new Set(exploredRes.records.map(r => toSafeNumber(r.get('nodeId'))));

    let exploredCount = 0;
    blastNodeIds.forEach(id => {
      if (exploredNodeIds.has(id)) {
        exploredCount++;
      }
    });

    return exploredCount / blastNodeIds.length;
  } catch (err) {
    console.error('Dependency Coverage computation failed:', err);
    return 0;
  } finally {
    await session.close();
  }
}

// Helper to normalize values using min-max normalization
function normalize(values: number[], val: number): number {
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === 0) return 0;
  if (max === min) return 1.0; // avoid divide-by-zero
  return (val - min) / (max - min);
}

// 5. Reviewer Recommendation
export async function getReviewerRecommendation(
  repoId: string,
  filePaths: string[],
  issueNumber: number
): Promise<{ candidates: ReviewerCandidate[]; candidate_pool_size: number }> {
  const session = driver.session();
  try {
    if (filePaths.length === 0) return { candidates: [], candidate_pool_size: 0 };

    // Get candidates: all contributors who have authored commits or reviewed PRs in the repo.
    // GitHub bot/app accounts (e.g. "dependabot[bot]", "copilot-pull-request-reviewer[bot]")
    // are excluded — the Reviewer Recommendation feature suggests a human maintainer to
    // route review to, and a bot account is never a meaningful suggestion there.
    const candidatesRes = await session.run(
      `MATCH (u:Contributor)
       WHERE NOT u.github_login ENDS WITH '[bot]'
       AND (
         exists {
           MATCH (c:Commit { repo_id: $repoId })-[:AUTHORED_BY]->(u)
         } OR exists {
           MATCH (pr:PullRequest { repo_id: $repoId })-[:REVIEWED_BY]->(u)
         }
       )
       RETURN u.github_login AS login`,
      { repoId }
    );

    const candidates = candidatesRes.records.map(r => r.get('login'));
    if (candidates.length === 0) return { candidates: [], candidate_pool_size: 0 };

    const rawScores: Record<string, { commitFreq: number; recency: number; ownership: number; reviewCount: number }> = {};

    // Initialize scores
    for (const c of candidates) {
      rawScores[c] = { commitFreq: 0, recency: 0, ownership: 0, reviewCount: 0 };
    }

    // Factor 1 & 3: Commit frequency & Ownership on target files
    const commitsRes = await session.run(
      `MATCH (f:File { repo_id: $repoId })
       WHERE f.path IN $filePaths
       MATCH (c:Commit)-[:MODIFIES]->(f)
       MATCH (c)-[:AUTHORED_BY]->(u:Contributor)
       RETURN u.github_login AS login, count(c) AS count`,
      { repoId, filePaths }
    );
    
    let totalCommits = 0;
    commitsRes.records.forEach(r => {
      const login = r.get('login');
      const count = toSafeNumber(r.get('count'));
      totalCommits += count;
      if (rawScores[login]) {
        rawScores[login].commitFreq = count;
      }
    });

    if (totalCommits > 0) {
      for (const c of candidates) {
        rawScores[c].ownership = rawScores[c].commitFreq / totalCommits;
      }
    }

    // Factor 2: Recency-decayed activity
    // Sum of e^(-lambda * days_ago) for commits in the repo
    const recencyRes = await session.run(
      `MATCH (c:Commit { repo_id: $repoId })-[:AUTHORED_BY]->(u:Contributor)
       RETURN u.github_login AS login, c.timestamp.epochMillis AS epoch`,
      { repoId }
    );
    const now = Date.now();
    const lambda = 0.02; // half-life ~35 days
    recencyRes.records.forEach(r => {
      const login = r.get('login');
      const epoch = toSafeNumber(r.get('epoch'));
      const daysAgo = (now - epoch) / (1000 * 60 * 60 * 24);
      const weight = Math.exp(-lambda * Math.max(0, daysAgo));
      if (rawScores[login]) {
        rawScores[login].recency += weight;
      }
    });

    // Factor 4: Review / comment count on related PRs (resolving issues sharing labels)
    const reviewRes = await session.run(
      `MATCH (i:Issue { repo_id: $repoId, number: $issueNumber })
       MATCH (other:Issue { repo_id: $repoId })
         WHERE other.number <> i.number AND any(l IN other.labels WHERE l IN i.labels)
       MATCH (pr:PullRequest)-[:RESOLVES]->(other)
       MATCH (pr)-[rev:REVIEWED_BY]->(u:Contributor)
       RETURN u.github_login AS login, sum(rev.comment_count) AS comments`,
      { repoId, issueNumber }
    );
    reviewRes.records.forEach(r => {
      const login = r.get('login');
      const comments = toSafeNumber(r.get('comments'));
      if (rawScores[login]) {
        rawScores[login].reviewCount = comments;
      }
    });

    // Extract arrays for normalization
    const commitFreqs = candidates.map(c => rawScores[c].commitFreq);
    const recencies = candidates.map(c => rawScores[c].recency);
    const ownerships = candidates.map(c => rawScores[c].ownership);
    const reviewCounts = candidates.map(c => rawScores[c].reviewCount);

    // Weights (configurable, defaults sum to 1.0)
    const w1 = 0.3; // commit frequency
    const w2 = 0.2; // recency decayed activity
    const w3 = 0.3; // ownership share
    const w4 = 0.2; // review / comment count

    const results: ReviewerCandidate[] = candidates.map(c => {
      const normCommit = normalize(commitFreqs, rawScores[c].commitFreq);
      const normRecency = normalize(recencies, rawScores[c].recency);
      const normOwnership = normalize(ownerships, rawScores[c].ownership);
      const normReview = normalize(reviewCounts, rawScores[c].reviewCount);

      const score = w1 * normCommit + w2 * normRecency + w3 * normOwnership + w4 * normReview;

      return {
        login: c,
        score: parseFloat(score.toFixed(3)),
        factors: {
          commit_frequency: parseFloat(normCommit.toFixed(3)),
          recency_decayed_activity: parseFloat(normRecency.toFixed(3)),
          ownership_share: parseFloat(normOwnership.toFixed(3)),
          review_comment_count: parseFloat(normReview.toFixed(3)),
        },
      };
    });

    return { candidates: results.sort((a, b) => b.score - a.score), candidate_pool_size: candidates.length };
  } catch (err) {
    console.error('Reviewer recommendation computation failed:', err);
    return { candidates: [], candidate_pool_size: 0 };
  } finally {
    await session.close();
  }
}
