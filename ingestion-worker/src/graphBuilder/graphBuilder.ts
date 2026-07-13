import { getNeo4jDriver } from '../neo4j/neo4jDriver';
import { ParsedFile, RepositoryNode } from 'shared';
import { GitHubCommit, GitHubPR, GitHubIssue, GitHubReview } from '../github/githubClient';
import * as path from 'path';

function toSafeNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
}

export class GraphBuilder {
  private driver = getNeo4jDriver();

  // Create Neo4j Constraints and Indexes from the schema spec
  async initSchema(): Promise<void> {
    const session = this.driver.session();
    try {
      const constraints = [
        `CREATE CONSTRAINT repository_id_unique IF NOT EXISTS FOR (r:Repository) REQUIRE r.repo_id IS UNIQUE`,
        `CREATE CONSTRAINT file_path_unique IF NOT EXISTS FOR (f:File) REQUIRE (f.repo_id, f.path) IS NODE KEY`,
        `CREATE CONSTRAINT function_id_unique IF NOT EXISTS FOR (fn:Function) REQUIRE fn.function_id IS UNIQUE`,
        `CREATE CONSTRAINT class_id_unique IF NOT EXISTS FOR (c:Class) REQUIRE c.class_id IS UNIQUE`,
        `CREATE CONSTRAINT commit_hash_unique IF NOT EXISTS FOR (c:Commit) REQUIRE (c.repo_id, c.hash) IS NODE KEY`,
        `CREATE CONSTRAINT pr_number_unique IF NOT EXISTS FOR (p:PullRequest) REQUIRE (p.repo_id, p.number) IS NODE KEY`,
        `CREATE CONSTRAINT issue_number_unique IF NOT EXISTS FOR (i:Issue) REQUIRE (i.repo_id, i.number) IS NODE KEY`,
        `CREATE CONSTRAINT contributor_login_unique IF NOT EXISTS FOR (u:Contributor) REQUIRE u.github_login IS UNIQUE`
      ];

      const indexes = [
        `CREATE INDEX file_repo_idx IF NOT EXISTS FOR (f:File) ON (f.repo_id)`,
        `CREATE INDEX function_file_idx IF NOT EXISTS FOR (fn:Function) ON (fn.file_path)`,
        `CREATE INDEX commit_timestamp_idx IF NOT EXISTS FOR (c:Commit) ON (c.timestamp)`,
        `CREATE INDEX issue_labels_idx IF NOT EXISTS FOR (i:Issue) ON (i.labels)`,
        `CREATE INDEX pr_state_idx IF NOT EXISTS FOR (p:PullRequest) ON (p.state)`
      ];

      for (const constraint of constraints) {
        await session.run(constraint);
      }
      for (const index of indexes) {
        await session.run(index);
      }
      
      // Fulltext indexes might throw if not supported, run them in try/catch blocks
      try {
        await session.run(`CREATE FULLTEXT INDEX issue_text_fulltext IF NOT EXISTS FOR (i:Issue) ON EACH [i.title, i.body]`);
      } catch (err) {}
      try {
        await session.run(`CREATE FULLTEXT INDEX pr_text_fulltext IF NOT EXISTS FOR (p:PullRequest) ON EACH [p.title, p.body]`);
      } catch (err) {}

      console.log('Neo4j schema constraints and indexes initialized.');
    } finally {
      await session.close();
    }
  }

  async upsertRepository(repo: RepositoryNode): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (r:Repository { repo_id: $repo_id })
         SET r.owner = $owner,
             r.name = $name,
             r.default_branch = $default_branch,
             r.last_ingested_commit_hash = $last_ingested_commit_hash,
             r.last_ingested_at = $last_ingested_at,
             r.file_count = $file_count,
             r.loc_count = $loc_count,
             r.ingestion_status = $ingestion_status,
             r.unresolved_edges_count = $unresolved_edges_count`,
        {
          repo_id: repo.repo_id,
          owner: repo.owner,
          name: repo.name,
          default_branch: repo.default_branch,
          last_ingested_commit_hash: repo.last_ingested_commit_hash ?? null,
          last_ingested_at: repo.last_ingested_at ?? null,
          file_count: repo.file_count !== undefined ? repo.file_count : null,
          loc_count: repo.loc_count !== undefined ? repo.loc_count : null,
          ingestion_status: repo.ingestion_status,
          unresolved_edges_count: repo.unresolved_edges_count !== undefined ? repo.unresolved_edges_count : null
        }
      );
    } finally {
      await session.close();
    }
  }

  async upsertFilesAndStructures(repoId: string, parsedFiles: ParsedFile[]): Promise<void> {
    const session = this.driver.session();
    try {
      for (const file of parsedFiles) {
        const fileExt = path.extname(file.path).replace('.', '');
        // 1. Merge File Node
        await session.run(
          `MERGE (f:File { repo_id: $repoId, path: $path })
           SET f.language = $language,
               f.loc = $loc`,
          { repoId, path: file.path, language: fileExt, loc: file.loc }
        );

        // 2. Merge Function Nodes
        for (const func of file.functions) {
          const functionId = `${repoId}::${file.path}::${func.name}::${func.startLine}`;
          await session.run(
            `MERGE (fn:Function { function_id: $functionId })
             SET fn.repo_id = $repoId,
                 fn.name = $name,
                 fn.file_path = $filePath,
                 fn.start_line = $startLine,
                 fn.end_line = $endLine`,
            {
              functionId,
              repoId,
              name: func.name,
              filePath: file.path,
              startLine: func.startLine,
              endLine: func.endLine,
            }
          );
        }

        // 3. Merge Class Nodes
        for (const cls of file.classes) {
          const classId = `${repoId}::${file.path}::${cls.name}`;
          await session.run(
            `MERGE (c:Class { class_id: $classId })
             SET c.repo_id = $repoId,
                 c.name = $name,
                 c.file_path = $filePath,
                 c.start_line = $startLine,
                 c.end_line = $endLine`,
            {
              classId,
              repoId,
              name: cls.name,
              filePath: file.path,
              startLine: cls.startLine,
              endLine: cls.endLine,
            }
          );
        }
      }
    } finally {
      await session.close();
    }
  }

  // Resolve imports, calls, inherits
  async buildStructuralRelationships(repoId: string, parsedFiles: ParsedFile[]): Promise<number> {
    const session = this.driver.session();
    let unresolvedCount = 0;
    try {
      // 1. Resolve IMPORTS & DEPENDS_ON
      for (const file of parsedFiles) {
        for (const imp of file.imports) {
          // Resolve relative path
          let resolvedPath = imp.importPath;
          let isInternal = false;

          if (imp.importPath.startsWith('.')) {
            isInternal = true;
            // Clean import path
            const baseDir = path.dirname(file.path);
            let targetPath = path.normalize(path.join(baseDir, imp.importPath)).replace(/\\/g, '/');
            // Try matching with common extensions
            const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
            let matched = false;
            for (const ext of extensions) {
              const testPath = targetPath.endsWith(ext) ? targetPath : `${targetPath}${ext}`;
              if (parsedFiles.some(f => f.path === testPath)) {
                resolvedPath = testPath;
                matched = true;
                break;
              }
            }
            if (!matched) {
              isInternal = false; // fallback to external representation if not found inside repo
            }
          } else if (imp.importPath.startsWith('@/')) {
            // Common tsconfig/jsconfig path alias (Next.js/Vite convention), e.g.
            // "@/components/Foo" typically maps to "src/components/Foo" or the repo
            // root. Without resolving this, every aliased internal import gets
            // misclassified as an external package literally named "@" — which
            // both breaks real dependency traversal for the file doing the import
            // AND pollutes the graph with a meaningless "package::@" node.
            const aliasedPath = imp.importPath.replace(/^@\//, '');
            const candidateRoots = ['src/', ''];
            const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
            outer:
            for (const root of candidateRoots) {
              for (const ext of extensions) {
                const testPath = `${root}${aliasedPath}${ext}`;
                if (parsedFiles.some(f => f.path === testPath)) {
                  resolvedPath = testPath;
                  isInternal = true;
                  break outer;
                }
              }
            }
            // If no match was found against actual ingested files, it falls through
            // to the external-dependency branch below rather than being silently
            // dropped — same safe fallback the relative-import branch already uses.
          }

          if (isInternal) {
            await session.run(
              `MATCH (a:File { repo_id: $repoId, path: $fromPath })
               MATCH (b:File { repo_id: $repoId, path: $toPath })
               MERGE (a)-[r:IMPORTS]->(b)
               SET r.import_path = $importPath, r.resolved = true`,
              { repoId, fromPath: file.path, toPath: resolvedPath, importPath: imp.importPath }
            );
          } else {
            // External dependency. Scoped npm packages (e.g. "@radix-ui/react-select")
            // must keep their full "@scope/name" as the package identity — taking only
            // the first path segment would truncate every scoped package down to just
            // its scope (e.g. "@radix-ui"), silently merging many distinct packages
            // into one node.
            const segments = imp.importPath.split('/');
            const pkgName = imp.importPath.startsWith('@') && segments.length > 1
              ? `${segments[0]}/${segments[1]}`
              : segments[0];
            const placeholderPath = `package::${pkgName}`;
            await session.run(
              `MERGE (b:File { repo_id: $repoId, path: $placeholderPath })
               SET b:ExternalPackage, b.language = 'external', b.loc = 0
               WITH b
               MATCH (a:File { repo_id: $repoId, path: $fromPath })
               MERGE (a)-[r:DEPENDS_ON]->(b)
               SET r.via_package = $pkgName`,
              { repoId, fromPath: file.path, placeholderPath, pkgName }
            );
          }
        }
      }

      // 2. Resolve CALLS
      for (const file of parsedFiles) {
        for (const func of file.functions) {
          const callerId = `${repoId}::${file.path}::${func.name}::${func.startLine}`;
          for (const call of func.calls) {
            // Basic resolution:
            // a. Check if function exists in the same file
            let calleeId = '';
            const localFunc = file.functions.find(f => f.name === call.callee);
            if (localFunc) {
              calleeId = `${repoId}::${file.path}::${localFunc.name}::${localFunc.startLine}`;
            } else {
              // b. Check if function is imported from another file
              const matchingImport = file.imports.find(imp => imp.specifiers.includes(call.callee));
              if (matchingImport && matchingImport.importPath.startsWith('.')) {
                const baseDir = path.dirname(file.path);
                let targetPath = path.normalize(path.join(baseDir, matchingImport.importPath)).replace(/\\/g, '/');
                const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
                let resolvedFile: ParsedFile | undefined;
                for (const ext of extensions) {
                  const testPath = targetPath.endsWith(ext) ? targetPath : `${targetPath}${ext}`;
                  resolvedFile = parsedFiles.find(f => f.path === testPath);
                  if (resolvedFile) break;
                }
                if (resolvedFile) {
                  const importedFunc = resolvedFile.functions.find(f => f.name === call.callee);
                  if (importedFunc) {
                    calleeId = `${repoId}::${resolvedFile.path}::${importedFunc.name}::${importedFunc.startLine}`;
                  }
                }
              }
            }

            if (calleeId) {
              await session.run(
                `MATCH (caller:Function { function_id: $callerId })
                 MATCH (callee:Function { function_id: $calleeId })
                 MERGE (caller)-[r:CALLS]->(callee)
                 SET r.call_site_line = $line, r.resolved = true`,
                { callerId, calleeId, line: call.line }
              );
            } else {
              unresolvedCount++;
            }
          }
        }
      }

      // 3. Resolve INHERITS
      for (const file of parsedFiles) {
        for (const cls of file.classes) {
          if (cls.superClass) {
            const classId = `${repoId}::${file.path}::${cls.name}`;
            // Try to find superclass in same file
            let superId = '';
            const localSuper = file.classes.find(c => c.name === cls.superClass);
            if (localSuper) {
              superId = `${repoId}::${file.path}::${localSuper.name}`;
            } else {
              // Check imports
              const matchingImport = file.imports.find(imp => imp.specifiers.includes(cls.superClass!));
              if (matchingImport && matchingImport.importPath.startsWith('.')) {
                const baseDir = path.dirname(file.path);
                let targetPath = path.normalize(path.join(baseDir, matchingImport.importPath)).replace(/\\/g, '/');
                const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
                let resolvedFile: ParsedFile | undefined;
                for (const ext of extensions) {
                  const testPath = targetPath.endsWith(ext) ? targetPath : `${targetPath}${ext}`;
                  resolvedFile = parsedFiles.find(f => f.path === testPath);
                  if (resolvedFile) break;
                }
                if (resolvedFile) {
                  const importedSuper = resolvedFile.classes.find(c => c.name === cls.superClass);
                  if (importedSuper) {
                    superId = `${repoId}::${resolvedFile.path}::${importedSuper.name}`;
                  }
                }
              }
            }

            if (superId) {
              await session.run(
                `MATCH (sub:Class { class_id: $classId })
                 MATCH (super:Class { class_id: $superId })
                 MERGE (sub)-[:INHERITS]->(super)`,
                { classId, superId }
              );
            }
          }
        }
      }
    } finally {
      await session.close();
    }
    return unresolvedCount;
  }

  // Upsert commits, PRs, issues, reviewers
  async upsertGitHubMetadata(
    repoId: string,
    commits: GitHubCommit[],
    prs: GitHubPR[],
    issues: GitHubIssue[],
    reviewsMap: Record<number, GitHubReview[]>
  ): Promise<void> {
    const session = this.driver.session();
    try {
      // 1. Upsert Contributors & Commits
      for (const c of commits) {
        const login = c.author?.login || 'unknown-contributor';
        const name = c.commit?.author?.name || 'Unknown Contributor';
        
        await session.run(
          `MERGE (u:Contributor { github_login: $login })
           SET u.display_name = $name`,
          { login, name }
        );

        await session.run(
          `MERGE (cm:Commit { repo_id: $repoId, hash: $hash })
           SET cm.message = $message,
               cm.timestamp = datetime($timestamp)`,
          {
            repoId,
            hash: c.sha,
            message: c.commit.message || '',
            timestamp: c.commit.author?.date || new Date().toISOString(),
          }
        );

        await session.run(
          `MATCH (cm:Commit { repo_id: $repoId, hash: $hash })
           MATCH (u:Contributor { github_login: $login })
           MERGE (cm)-[:AUTHORED_BY]->(u)`,
          { repoId, hash: c.sha, login }
        );

        // Link Commit -> Files Modified
        if (c.files) {
          for (const file of c.files) {
            await session.run(
              `MATCH (f:File { repo_id: $repoId, path: $path })
               MATCH (cm:Commit { repo_id: $repoId, hash: $hash })
               MERGE (cm)-[r:MODIFIES]->(f)
               SET r.additions = $additions,
                   r.deletions = $deletions`,
              {
                repoId,
                path: file.filename,
                hash: c.sha,
                additions: file.additions,
                deletions: file.deletions,
              }
            );
          }
        }
      }

      // 2. Upsert Pull Requests and Link to Commits
      for (const pr of prs) {
        const login = pr.user?.login || 'unknown-contributor';
        await session.run(
          `MERGE (u:Contributor { github_login: $login })
           SET u.display_name = $login`,
          { login }
        );

        const prState = pr.state === 'closed' && pr.merged_at ? 'merged' : pr.state;
        await session.run(
          `MERGE (p:PullRequest { repo_id: $repoId, number: $number })
           SET p.title = $title,
               p.body = $body,
               p.state = $state,
               p.created_at = datetime($createdAt),
               p.merged_at = case when $mergedAt IS NOT NULL then datetime($mergedAt) else null end`,
          {
            repoId,
            number: pr.number,
            title: pr.title || '',
            body: pr.body || '',
            state: prState,
            createdAt: pr.created_at,
            mergedAt: pr.merged_at,
          }
        );

        // Try to link commits in this repository to the PR (if commits mention PR number, or if we map them)
        // Since we are fetching via GitHub, we can link commits whose messages mention "pull request #N" or simply link them in order.
        // For the graph builder, we can link commits to their PRs if we scan commit messages for PR mentions or if we fetch via Github PR commits endpoint.
        // A simple heuristic for graph construction:
        await session.run(
          `MATCH (cm:Commit { repo_id: $repoId })
           WHERE cm.message CONTAINS $prText OR cm.message CONTAINS $mergeText
           MATCH (p:PullRequest { repo_id: $repoId, number: $number })
           MERGE (cm)-[:PART_OF]->(p)`,
          {
            repoId,
            number: pr.number,
            prText: `(#${pr.number})`,
            mergeText: `Merge pull request #${pr.number}`,
          }
        );

        // 3. PR Reviews -> REVIEWED_BY
        const reviews = reviewsMap[pr.number] || [];
        for (const rev of reviews) {
          const revLogin = rev.user?.login || 'unknown-contributor';
          await session.run(
            `MERGE (u:Contributor { github_login: $revLogin })`,
            { revLogin }
          );

          await session.run(
            `MATCH (p:PullRequest { repo_id: $repoId, number: $number })
             MATCH (u:Contributor { github_login: $revLogin })
             MERGE (p)-[r:REVIEWED_BY]->(u)
             ON CREATE SET r.comment_count = 1, r.review_state = $state
             ON MATCH SET r.comment_count = r.comment_count + 1, r.review_state = $state`,
            { repoId, number: pr.number, revLogin, state: rev.state }
          );
        }
      }

      // 4. Upsert Issues and Link to PRs (RESOLVES)
      for (const issue of issues) {
        const labelsList = issue.labels.map(l => l.name);
        await session.run(
          `MERGE (i:Issue { repo_id: $repoId, number: $number })
           SET i.title = $title,
               i.body = $body,
               i.labels = $labels,
               i.state = $state,
               i.created_at = datetime($createdAt)`,
          {
            repoId,
            number: issue.number,
            title: issue.title || '',
            body: issue.body || '',
            labels: labelsList,
            state: issue.state,
            createdAt: issue.created_at,
          }
        );

        // Check if any PR resolves this issue by looking at PR titles/bodies for closing keywords:
        // "fixes #N", "resolves #N", "closes #N"
        await session.run(
          `MATCH (p:PullRequest { repo_id: $repoId })
           WHERE p.body CONTAINS $fixesPattern 
              OR p.body CONTAINS $closesPattern 
              OR p.body CONTAINS $resolvesPattern
              OR p.title CONTAINS $fixesPattern
           MATCH (i:Issue { repo_id: $repoId, number: $number })
           MERGE (p)-[:RESOLVES]->(i)`,
          {
            repoId,
            number: issue.number,
            fixesPattern: `fixes #${issue.number}`,
            closesPattern: `closes #${issue.number}`,
            resolvesPattern: `resolves #${issue.number}`,
          }
        );
      }
    } finally {
      await session.close();
    }
  }

  // Create REFERENCES edges (Issue/PR -> File/Function) by scanning texts for mentions
  async buildTextReferences(repoId: string, parsedFiles: ParsedFile[]): Promise<void> {
    const session = this.driver.session();
    try {
      // Fetch all issues and PRs in this repo
      const issuesResult = await session.run(`MATCH (i:Issue { repo_id: $repoId }) RETURN i.number AS num, i.title + " " + i.body AS text`, { repoId });
      const prsResult = await session.run(`MATCH (p:PullRequest { repo_id: $repoId }) RETURN p.number AS num, p.title + " " + p.body AS text`, { repoId });

      const filesResult = await session.run(`MATCH (f:File { repo_id: $repoId }) RETURN f.path AS path`, { repoId });
      const functionsResult = await session.run(`MATCH (fn:Function { repo_id: $repoId }) RETURN fn.function_id AS id, fn.name AS name, fn.file_path AS filePath`, { repoId });

      const files = filesResult.records.map(r => r.get('path'));
      const functions = functionsResult.records.map(r => ({
        id: r.get('id'),
        name: r.get('name'),
        filePath: r.get('filePath'),
      }));

      const issueFileRefs: { num: number; file: string; confidence: number; method: string }[] = [];
      const issueFnRefs: { num: number; fnId: string; confidence: number; method: string }[] = [];
      const prFileRefs: { num: number; file: string; confidence: number; method: string }[] = [];
      const prFnRefs: { num: number; fnId: string; confidence: number; method: string }[] = [];

      // Scan issues
      for (const record of issuesResult.records) {
        const num = toSafeNumber(record.get('num'));
        // Cypher's string concatenation (title + " " + body) returns null if either
        // property is null — guard here so a single malformed issue/PR never crashes
        // the whole ingestion run.
        const text = record.get('text') || '';

        for (const file of files) {
          const basename = path.basename(file);
          if (text.includes(file)) {
            issueFileRefs.push({ num, file, confidence: 1.0, method: 'explicit_path_mention' });
          } else if (text.includes(basename) && basename.length > 5) {
            issueFileRefs.push({ num, file, confidence: 0.6, method: 'basename_mention' });
          }
        }

        for (const fn of functions) {
          if (fn.name !== 'anonymous' && fn.name.length > 4 && text.includes(`${fn.name}(`)) {
            issueFnRefs.push({ num, fnId: fn.id, confidence: 0.8, method: 'function_call_mention' });
          }
        }
      }

      // Scan PRs
      for (const record of prsResult.records) {
        const num = toSafeNumber(record.get('num'));
        const text = record.get('text') || '';

        for (const file of files) {
          const basename = path.basename(file);
          if (text.includes(file)) {
            prFileRefs.push({ num, file, confidence: 1.0, method: 'explicit_path_mention' });
          } else if (text.includes(basename) && basename.length > 5) {
            prFileRefs.push({ num, file, confidence: 0.6, method: 'basename_mention' });
          }
        }

        for (const fn of functions) {
          if (fn.name !== 'anonymous' && fn.name.length > 4 && text.includes(`${fn.name}(`)) {
            prFnRefs.push({ num, fnId: fn.id, confidence: 0.8, method: 'function_call_mention' });
          }
        }
      }

      // Batch write issue file references
      if (issueFileRefs.length > 0) {
        await session.run(
          `UNWIND $refs AS ref
           MATCH (i:Issue { repo_id: $repoId, number: ref.num })
           MATCH (f:File { repo_id: $repoId, path: ref.file })
           MERGE (i)-[r:REFERENCES]->(f)
           SET r.confidence = ref.confidence, r.extraction_method = ref.method`,
          { repoId, refs: issueFileRefs }
        );
      }

      // Batch write issue function references
      if (issueFnRefs.length > 0) {
        await session.run(
          `UNWIND $refs AS ref
           MATCH (i:Issue { repo_id: $repoId, number: ref.num })
           MATCH (f:Function { function_id: ref.fnId })
           MERGE (i)-[r:REFERENCES]->(f)
           SET r.confidence = ref.confidence, r.extraction_method = ref.method`,
          { repoId, refs: issueFnRefs }
        );
      }

      // Batch write PR file references
      if (prFileRefs.length > 0) {
        await session.run(
          `UNWIND $refs AS ref
           MATCH (p:PullRequest { repo_id: $repoId, number: ref.num })
           MATCH (f:File { repo_id: $repoId, path: ref.file })
           MERGE (p)-[r:REFERENCES]->(f)
           SET r.confidence = ref.confidence, r.extraction_method = ref.method`,
          { repoId, refs: prFileRefs }
        );
      }

      // Batch write PR function references
      if (prFnRefs.length > 0) {
        await session.run(
          `UNWIND $refs AS ref
           MATCH (p:PullRequest { repo_id: $repoId, number: ref.num })
           MATCH (f:Function { function_id: ref.fnId })
           MERGE (p)-[r:REFERENCES]->(f)
           SET r.confidence = ref.confidence, r.extraction_method = ref.method`,
          { repoId, refs: prFnRefs }
        );
      }

    } finally {
      await session.close();
    }
  }

  // Compute live in-degree centrality weight metrics and save to graph
  async computeCentralities(repoId: string): Promise<void> {
    const session = this.driver.session();
    try {
      // 1. Files in-degree centrality
      // Count incoming IMPORTS and DEPENDS_ON relations
      await session.run(
        `MATCH (f:File { repo_id: $repoId })
         WHERE NOT f:ExternalPackage
         OPTIONAL MATCH (other:File { repo_id: $repoId })-[r:IMPORTS|DEPENDS_ON]->(f)
         WITH f, count(r) AS inDegree
         SET f.in_degree_centrality = toFloat(inDegree)`,
        { repoId }
      );

      // 2. Functions in-degree centrality
      // Count incoming CALLS relations
      await session.run(
        `MATCH (fn:Function { repo_id: $repoId })
         OPTIONAL MATCH (other:Function { repo_id: $repoId })-[r:CALLS]->(fn)
         WITH fn, count(r) AS inDegree
         SET fn.in_degree_centrality = toFloat(inDegree)`,
        { repoId }
      );
      
      console.log('In-degree centrality weights computed for files and functions.');
    } finally {
      await session.close();
    }
  }
}
