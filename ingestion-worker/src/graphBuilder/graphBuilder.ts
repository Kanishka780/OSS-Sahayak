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
      const files: { path: string; language: string; loc: number }[] = [];
      const functions: { id: string; name: string; filePath: string; startLine: number; endLine: number }[] = [];
      const classes: { id: string; name: string; filePath: string; startLine: number; endLine: number }[] = [];

      for (const file of parsedFiles) {
        const fileExt = path.extname(file.path).replace('.', '');
        files.push({ path: file.path, language: fileExt, loc: file.loc });

        for (const func of file.functions) {
          const functionId = `${repoId}::${file.path}::${func.name}::${func.startLine}`;
          functions.push({
            id: functionId,
            name: func.name,
            filePath: file.path,
            startLine: func.startLine,
            endLine: func.endLine
          });
        }

        for (const cls of file.classes) {
          const classId = `${repoId}::${file.path}::${cls.name}`;
          classes.push({
            id: classId,
            name: cls.name,
            filePath: file.path,
            startLine: cls.startLine,
            endLine: cls.endLine
          });
        }
      }

      if (files.length > 0) {
        await session.run(
          `UNWIND $files AS file
           MERGE (f:File { repo_id: $repoId, path: file.path })
           SET f.language = file.language,
               f.loc = file.loc`,
          { repoId, files }
        );
      }

      if (functions.length > 0) {
        await session.run(
          `UNWIND $funcs AS func
           MERGE (fn:Function { function_id: func.id })
           SET fn.repo_id = $repoId,
               fn.name = func.name,
               fn.file_path = func.filePath,
               fn.start_line = func.startLine,
               fn.end_line = func.endLine`,
          { repoId, funcs: functions }
        );
      }

      if (classes.length > 0) {
        await session.run(
          `UNWIND $classes AS cls
           MERGE (c:Class { class_id: cls.id })
           SET c.repo_id = $repoId,
               c.name = cls.name,
               c.file_path = cls.filePath,
               c.start_line = cls.startLine,
               c.end_line = cls.endLine`,
          { repoId, classes }
        );
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
      const internalImports: { fromPath: string; toPath: string; importPath: string }[] = [];
      const externalDeps: { fromPath: string; placeholderPath: string; pkgName: string }[] = [];
      const calls: { callerId: string; calleeId: string; line: number }[] = [];
      const inherits: { classId: string; superId: string }[] = [];

      // 1. Resolve IMPORTS & DEPENDS_ON
      for (const file of parsedFiles) {
        for (const imp of file.imports) {
          let resolvedPath = imp.importPath;
          let isInternal = false;

          if (imp.importPath.startsWith('.')) {
            isInternal = true;
            const baseDir = path.dirname(file.path);
            let targetPath = path.normalize(path.join(baseDir, imp.importPath)).replace(/\\/g, '/');
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
              isInternal = false;
            }
          } else if (imp.importPath.startsWith('@/')) {
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
          }

          if (isInternal) {
            internalImports.push({ fromPath: file.path, toPath: resolvedPath, importPath: imp.importPath });
          } else {
            const segments = imp.importPath.split('/');
            const pkgName = imp.importPath.startsWith('@') && segments.length > 1
              ? `${segments[0]}/${segments[1]}`
              : segments[0];
            const placeholderPath = `package::${pkgName}`;
            externalDeps.push({ fromPath: file.path, placeholderPath, pkgName });
          }
        }
      }

      // 2. Resolve CALLS
      for (const file of parsedFiles) {
        for (const func of file.functions) {
          const callerId = `${repoId}::${file.path}::${func.name}::${func.startLine}`;
          for (const call of func.calls) {
            let calleeId = '';
            const localFunc = file.functions.find(f => f.name === call.callee);
            if (localFunc) {
              calleeId = `${repoId}::${file.path}::${localFunc.name}::${localFunc.startLine}`;
            } else {
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
              calls.push({ callerId, calleeId, line: call.line });
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
            let superId = '';
            const localSuper = file.classes.find(c => c.name === cls.superClass);
            if (localSuper) {
              superId = `${repoId}::${file.path}::${localSuper.name}`;
            } else {
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
              inherits.push({ classId, superId });
            }
          }
        }
      }

      // Batch Write Internal Imports
      if (internalImports.length > 0) {
        await session.run(
          `UNWIND $imports AS imp
           MATCH (a:File { repo_id: $repoId, path: imp.fromPath })
           MATCH (b:File { repo_id: $repoId, path: imp.toPath })
           MERGE (a)-[r:IMPORTS]->(b)
           SET r.import_path = imp.importPath, r.resolved = true`,
          { repoId, imports: internalImports }
        );
      }

      // Batch Write External Dependencies
      if (externalDeps.length > 0) {
        await session.run(
          `UNWIND $deps AS dep
           MERGE (b:File { repo_id: $repoId, path: dep.placeholderPath })
           SET b:ExternalPackage, b.language = 'external', b.loc = 0
           WITH b, dep
           MATCH (a:File { repo_id: $repoId, path: dep.fromPath })
           MERGE (a)-[r:DEPENDS_ON]->(b)
           SET r.via_package = dep.pkgName`,
          { repoId, deps: externalDeps }
        );
      }

      // Batch Write Calls
      if (calls.length > 0) {
        await session.run(
          `UNWIND $calls AS call
           MATCH (caller:Function { function_id: call.callerId })
           MATCH (callee:Function { function_id: call.calleeId })
           MERGE (caller)-[r:CALLS]->(callee)
           SET r.call_site_line = call.line, r.resolved = true`,
          { calls }
        );
      }

      // Batch Write Inherits
      if (inherits.length > 0) {
        await session.run(
          `UNWIND $inherits AS inh
           MATCH (sub:Class { class_id: inh.classId })
           MATCH (super:Class { class_id: inh.superId })
           MERGE (sub)-[:INHERITS]->(super)`,
          { inherits }
        );
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
      const contributorsMap = new Map<string, string>();
      const commitRecords: { hash: string; message: string; timestamp: string; login: string }[] = [];
      const modifiesRecords: { hash: string; path: string; additions: number; deletions: number }[] = [];
      const prRecords: { number: number; title: string; body: string; state: string; createdAt: string; mergedAt: string | null; login: string }[] = [];
      const prLinks: { number: number; prText: string; mergeText: string }[] = [];
      const reviewRecords: { number: number; revLogin: string; state: string }[] = [];
      const issueRecords: { number: number; title: string; body: string; labels: string[]; state: string; createdAt: string }[] = [];
      const resolveLinks: { number: number; fixesPattern: string; closesPattern: string; resolvesPattern: string }[] = [];

      // 1. Process Contributors & Commits
      for (const c of commits) {
        const login = c.author?.login || 'unknown-contributor';
        const name = c.commit?.author?.name || 'Unknown Contributor';
        contributorsMap.set(login, name);

        commitRecords.push({
          hash: c.sha,
          message: c.commit.message || '',
          timestamp: c.commit.author?.date || new Date().toISOString(),
          login
        });

        if (c.files) {
          for (const file of c.files) {
            modifiesRecords.push({
              hash: c.sha,
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions
            });
          }
        }
      }

      // 2. Process Pull Requests
      for (const pr of prs) {
        const login = pr.user?.login || 'unknown-contributor';
        contributorsMap.set(login, login);

        const prState = pr.state === 'closed' && pr.merged_at ? 'merged' : pr.state;
        prRecords.push({
          number: pr.number,
          title: pr.title || '',
          body: pr.body || '',
          state: prState,
          createdAt: pr.created_at,
          mergedAt: pr.merged_at || null,
          login
        });

        prLinks.push({
          number: pr.number,
          prText: `(#${pr.number})`,
          mergeText: `Merge pull request #${pr.number}`
        });

        const reviews = reviewsMap[pr.number] || [];
        for (const rev of reviews) {
          const revLogin = rev.user?.login || 'unknown-contributor';
          contributorsMap.set(revLogin, revLogin);
          reviewRecords.push({
            number: pr.number,
            revLogin,
            state: rev.state
          });
        }
      }

      // 3. Process Issues
      for (const issue of issues) {
        const labelsList = issue.labels.map(l => l.name);
        issueRecords.push({
          number: issue.number,
          title: issue.title || '',
          body: issue.body || '',
          labels: labelsList,
          state: issue.state,
          createdAt: issue.created_at
        });

        resolveLinks.push({
          number: issue.number,
          fixesPattern: `fixes #${issue.number}`,
          closesPattern: `closes #${issue.number}`,
          resolvesPattern: `resolves #${issue.number}`
        });
      }

      // Write unique Contributors
      const uniqueContributors = Array.from(contributorsMap.entries()).map(([login, name]) => ({ login, name }));
      if (uniqueContributors.length > 0) {
        await session.run(
          `UNWIND $contributors AS u
           MERGE (contrib:Contributor { github_login: u.login })
           SET contrib.display_name = u.name`,
          { contributors: uniqueContributors }
        );
      }

      // Write Commits
      if (commitRecords.length > 0) {
        await session.run(
          `UNWIND $commits AS c
           MERGE (cm:Commit { repo_id: $repoId, hash: c.hash })
           SET cm.message = c.message,
               cm.timestamp = datetime(c.timestamp)
           WITH cm, c
           MATCH (u:Contributor { github_login: c.login })
           MERGE (cm)-[:AUTHORED_BY]->(u)`,
          { repoId, commits: commitRecords }
        );
      }

      // Link Commit -> Files Modified
      if (modifiesRecords.length > 0) {
        await session.run(
          `UNWIND $modifies AS mod
           MATCH (f:File { repo_id: $repoId, path: mod.path })
           MATCH (cm:Commit { repo_id: $repoId, hash: mod.hash })
           MERGE (cm)-[r:MODIFIES]->(f)
           SET r.additions = mod.additions,
               r.deletions = mod.deletions`,
          { repoId, modifies: modifiesRecords }
        );
      }

      // Write Pull Requests
      if (prRecords.length > 0) {
        await session.run(
          `UNWIND $prs AS pr
           MERGE (p:PullRequest { repo_id: $repoId, number: pr.number })
           SET p.title = pr.title,
               p.body = pr.body,
               p.state = pr.state,
               p.created_at = datetime(pr.createdAt),
               p.merged_at = case when pr.mergedAt IS NOT NULL then datetime(pr.mergedAt) else null end
           WITH p, pr
           MATCH (u:Contributor { github_login: pr.login })
           MERGE (p)-[:AUTHORED_BY]->(u)`,
          { repoId, prs: prRecords }
        );
      }

      // Link Commits to Pull Requests
      if (prLinks.length > 0) {
        await session.run(
          `UNWIND $links AS link
           MATCH (cm:Commit { repo_id: $repoId })
             WHERE cm.message CONTAINS link.prText OR cm.message CONTAINS link.mergeText
           MATCH (p:PullRequest { repo_id: $repoId, number: link.number })
           MERGE (cm)-[:PART_OF]->(p)`,
          { repoId, links: prLinks }
        );
      }

      // Write PR Reviews
      if (reviewRecords.length > 0) {
        await session.run(
          `UNWIND $reviews AS rev
           MATCH (p:PullRequest { repo_id: $repoId, number: rev.number })
           MATCH (u:Contributor { github_login: rev.revLogin })
           MERGE (p)-[r:REVIEWED_BY]->(u)
           ON CREATE SET r.comment_count = 1, r.review_state = rev.state
           ON MATCH SET r.comment_count = r.comment_count + 1, r.review_state = rev.state`,
          { repoId, reviews: reviewRecords }
        );
      }

      // Write Issues
      if (issueRecords.length > 0) {
        await session.run(
          `UNWIND $issues AS issue
           MERGE (i:Issue { repo_id: $repoId, number: issue.number })
           SET i.title = issue.title,
               i.body = issue.body,
               i.labels = issue.labels,
               i.state = issue.state,
               i.created_at = datetime(issue.createdAt)`,
          { repoId, issues: issueRecords }
        );
      }

      // Link Issues to PRs (RESOLVES)
      if (resolveLinks.length > 0) {
        await session.run(
          `UNWIND $links AS link
           MATCH (p:PullRequest { repo_id: $repoId })
             WHERE p.body CONTAINS link.fixesPattern 
                OR p.body CONTAINS link.closesPattern 
                OR p.body CONTAINS link.resolvesPattern
                OR p.title CONTAINS link.fixesPattern
           MATCH (i:Issue { repo_id: $repoId, number: link.number })
           MERGE (p)-[:RESOLVES]->(i)`,
          { repoId, links: resolveLinks }
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
