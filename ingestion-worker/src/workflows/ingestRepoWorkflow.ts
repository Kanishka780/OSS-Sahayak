import { GitHubClient } from '../github/githubClient';
import { parseSourceFile } from '../parsing/treeSitterParser';
import { GraphBuilder } from '../graphBuilder/graphBuilder';
import { RepositoryNode, ParsedFile } from 'shared';

export async function runIngestion(repoId: string, forceFull = false): Promise<void> {
  const startTime = new Date();
  console.log(`Starting ingestion for repository: ${repoId} at ${startTime.toISOString()}`);
  
  const github = new GitHubClient(repoId);
  const builder = new GraphBuilder();

  // 1. Initialize DB constraints & indexes
  await builder.initSchema();

  try {
    // Set status to ingesting
    const repoMeta = await github.getRepoMetadata();
    const repoRecord: RepositoryNode = {
      repo_id: repoId,
      owner: repoId.split('/')[0],
      name: repoId.split('/')[1],
      default_branch: repoMeta.default_branch,
      ingestion_status: 'ingesting',
      last_ingested_at: startTime.toISOString(),
    };
    await builder.upsertRepository(repoRecord);

    // 2. Fetch File Tree
    console.log(`Fetching file tree for branch: ${repoMeta.default_branch}...`);
    const tree = await github.getFileTree(repoMeta.default_branch);
    
    // Filter for code files (TS/JS/TSX/JSX)
    const codeFiles = tree.filter(f => 
      f.type === 'blob' && 
      /\.(ts|tsx|js|jsx)$/.test(f.path) &&
      !f.path.includes('node_modules') &&
      !f.path.includes('dist') &&
      !f.path.includes('build')
    );
    
    console.log(`Found ${codeFiles.length} code files out of ${tree.length} total files.`);

    // If too large, we add a scope warning but still proceed
    const isExceedsScope = codeFiles.length > 5000;
    if (isExceedsScope) {
      console.warn(`WARNING: Repo exceeds target scale limit of 5,000 files.`);
    }

    // 3. Download and parse files
    const parsedFiles: ParsedFile[] = [];
    let parsedCount = 0;
    let totalLoc = 0;

    for (const file of codeFiles) {
      try {
        console.log(`[${++parsedCount}/${codeFiles.length}] Parsing ${file.path}...`);
        const content = await github.getFileContent(file.path);
        const parsed = await parseSourceFile(file.path, content);
        parsedFiles.push(parsed);
        totalLoc += parsed.loc;
      } catch (err: any) {
        console.error(`Skipped file ${file.path} due to parse error: ${err.message}`);
      }
    }

    // 4. Write structure nodes (Files, Functions, Classes) to Neo4j
    console.log(`Writing nodes to Neo4j...`);
    await builder.upsertFilesAndStructures(repoId, parsedFiles);

    // 5. Resolve structural relationships (IMPORTS, CALLS, INHERITS, DEPENDS_ON)
    console.log(`Resolving code relationships...`);
    const unresolvedCount = await builder.buildStructuralRelationships(repoId, parsedFiles);
    console.log(`Code relationships resolved. Unresolved function calls: ${unresolvedCount}`);

    // 6. Fetch Git metadata from GitHub API
    console.log(`Fetching commits, PRs, issues and reviews...`);
    const commits = await github.getCommits(100);
    const prs = await github.getPRs(50);
    const issues = await github.getIssues(50);

    // Fetch reviews for PRs
    const reviewsMap: Record<number, any[]> = {};
    for (const pr of prs) {
      const reviews = await github.getPRReviews(pr.number);
      reviewsMap[pr.number] = reviews;
    }

    // 7. Write Git metadata to Neo4j
    console.log(`Writing Git metadata to Neo4j...`);
    await builder.upsertGitHubMetadata(repoId, commits, prs, issues, reviewsMap);

    // 8. Build cross-references (REFERENCES)
    console.log(`Building references from issues and PRs...`);
    await builder.buildTextReferences(repoId, parsedFiles);

    // 9. Compute centrality weights (in-degree centrality)
    console.log(`Computing graph metrics...`);
    await builder.computeCentralities(repoId);

    // 10. Update repository node with ready status
    const latestCommitHash = commits[0]?.sha || '';
    const endTime = new Date();
    await builder.upsertRepository({
      repo_id: repoId,
      owner: repoId.split('/')[0],
      name: repoId.split('/')[1],
      default_branch: repoMeta.default_branch,
      last_ingested_commit_hash: latestCommitHash,
      last_ingested_at: endTime.toISOString(),
      file_count: codeFiles.length,
      loc_count: totalLoc,
      ingestion_status: 'ready',
      unresolved_edges_count: unresolvedCount,
    });

    console.log(`Ingestion completed successfully in ${((endTime.getTime() - startTime.getTime()) / 1000).toFixed(2)} seconds!`);
  } catch (error: any) {
    console.error(`Ingestion failed for ${repoId}:`, error);
    // Mark repository as failed
    try {
      const parts = repoId.split('/');
      await builder.upsertRepository({
        repo_id: repoId,
        owner: parts[0],
        name: parts[1],
        default_branch: 'main',
        ingestion_status: 'failed',
      });
    } catch (dbErr) {
      console.error(`Failed to update repo failure status:`, dbErr);
    }
    throw error;
  }
}

// standalone trigger script
if (require.main === module) {
  const testRepo = process.argv[2] || 'octocat/Hello-World';
  runIngestion(testRepo)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
