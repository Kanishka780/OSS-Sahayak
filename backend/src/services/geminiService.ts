import { GoogleGenAI, Type } from '@google/genai';
import { getNeo4jDriver } from './neo4jService';
import { EvidenceLink } from 'shared';
import * as dotenv from 'dotenv';
dotenv.config();

function cleanAndParseJSON(text: string): any {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();
  }
  return JSON.parse(cleaned);
}

function toSafeNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
}

export class GeminiService {
  private ai: GoogleGenAI | null = null;
  private driver = getNeo4jDriver();

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
    } else {
      console.warn('GEMINI_API_KEY is not set. GeminiService will run in degraded mode.');
    }
  }

  // Ask Gemini to extract which files or functions the question is asking about
  private async extractQueryTargets(question: string): Promise<{ files: string[]; functions: string[] }> {
    if (!this.ai) return { files: [], functions: [] };

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `Analyze this developer question: "${question}".
Identify any filenames, relative paths, or function names mentioned or implicitly referred to.
Return your response ONLY as a JSON object of this shape:
{
  "files": ["src/auth.ts", "SessionManager.ts"],
  "functions": ["validateUser", "login"]
}
Do not write anything else.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              files: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "List of files or paths mentioned in the question"
              },
              functions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "List of function or method names mentioned in the question"
              }
            },
            required: ["files", "functions"]
          }
        }
      });

      const text = response.text || '{}';
      const parsed = cleanAndParseJSON(text);
      return {
        files: parsed.files || [],
        functions: parsed.functions || [],
      };
    } catch (err) {
      console.error('Gemini target extraction failed:', err);
      return { files: [], functions: [] };
    }
  }

  // Retrieve Graph Context for the targets
  private async getGraphContext(repoId: string, files: string[], functions: string[]): Promise<any[]> {
    const session = this.driver.session();
    const context: any[] = [];
    try {
      // Query 1: Fetch File Nodes and their imports/dependencies
      if (files.length > 0) {
        const fileRes = await session.run(
          `MATCH (f:File { repo_id: $repoId })
           WHERE f.path IN $files OR any(target IN $files WHERE f.path STARTS WITH target OR f.path CONTAINS "/" + target OR target CONTAINS f.path OR f.path CONTAINS target)
           OPTIONAL MATCH (f)-[r:IMPORTS|DEPENDS_ON]->(other:File)
           RETURN f, type(r) AS rel, other.path AS otherPath`,
          { repoId, files }
        );
        fileRes.records.forEach(rec => {
          const node = rec.get('f').properties;
          context.push({ type: 'File', properties: node, rel: rec.get('rel'), target: rec.get('otherPath') });
        });
      }

      // Query 2: Fetch Function Nodes and call relationships
      if (functions.length > 0) {
        const funcRes = await session.run(
          `MATCH (fn:Function { repo_id: $repoId })
           WHERE fn.name IN $functions
           OPTIONAL MATCH (fn)-[r:CALLS]->(other:Function)
           RETURN fn, other.name AS otherName`,
          { repoId, functions }
        );
        funcRes.records.forEach(rec => {
          const node = rec.get('fn').properties;
          context.push({ type: 'Function', properties: node, rel: 'CALLS', target: rec.get('otherName') });
        });
      }

      // Query 3: Fetch related Commits, PRs, and Issues for the matched files
      if (files.length > 0) {
        const historyRes = await session.run(
          `MATCH (f:File { repo_id: $repoId })
           WHERE f.path IN $files OR any(target IN $files WHERE f.path STARTS WITH target OR f.path CONTAINS "/" + target OR target CONTAINS f.path OR f.path CONTAINS target)
           MATCH (c:Commit)-[:MODIFIES]->(f)
           OPTIONAL MATCH (c)-[:PART_OF]->(pr:PullRequest)
           OPTIONAL MATCH (pr)-[:RESOLVES]->(iss:Issue)
           RETURN f.path AS filePath, c.hash AS commitHash, c.message AS commitMsg, pr.number AS prNum, iss.number AS issueNum
           LIMIT 10`,
          { repoId, files }
        );
        historyRes.records.forEach(rec => {
          context.push({
            type: 'History',
            file: rec.get('filePath'),
            commit: { hash: rec.get('commitHash'), message: rec.get('commitMsg') },
            pr: rec.get('prNum') ? toSafeNumber(rec.get('prNum')) : null,
            issue: rec.get('issueNum') ? toSafeNumber(rec.get('issueNum')) : null,
          });
        });
      }
    } catch (err) {
      console.error('Neo4j context retrieval failed:', err);
    } finally {
      await session.close();
    }
    return context;
  }

  // Record Q&A and Evidence citations in Neo4j
  private async recordQuestionHistory(
    repoId: string,
    issueNumber: number,
    question: string,
    answer: string | null,
    refusal: boolean,
    evidenceChain: EvidenceLink[]
  ): Promise<void> {
    const session = this.driver.session();
    try {
      const login = 'contributor_user'; // Mock/Default contributor session

      // Merge Contributor and Query Node
      await session.run(
        `MERGE (u:Contributor { github_login: $login })
         CREATE (q:Query {
           question: $question,
           answer: $answer,
           refusal: $refusal,
           timestamp: datetime()
         })
         MERGE (u)-[:ASKED]->(q)`,
        { login, question, answer, refusal }
      );

      // Link Query to Cited Nodes
      if (!refusal && evidenceChain.length > 0) {
        for (const citation of evidenceChain) {
          if (citation.type === 'File') {
            await session.run(
              `MATCH (q:Query { question: $question })
               MATCH (f:File { repo_id: $repoId, path: $path })
               MERGE (q)-[:CITES]->(f)`,
              { question, repoId, path: citation.id }
            );
          } else if (citation.type === 'Function') {
            await session.run(
              `MATCH (q:Query { question: $question })
               MATCH (fn:Function { function_id: $fnId })
               MERGE (q)-[:CITES]->(fn)`,
              { question, fnId: citation.id }
            );
          } else if (citation.type === 'Commit') {
            await session.run(
              `MATCH (q:Query { question: $question })
               MATCH (c:Commit { repo_id: $repoId, hash: $hash })
               MERGE (q)-[:CITES]->(c)`,
              { question, repoId, hash: citation.id }
            );
          } else if (citation.type === 'PullRequest') {
            await session.run(
              `MATCH (q:Query { question: $question })
               MATCH (pr:PullRequest { repo_id: $repoId, number: $num })
               MERGE (q)-[:CITES]->(pr)`,
              { question, repoId, num: Number(citation.id) }
            );
          } else if (citation.type === 'Issue') {
            await session.run(
              `MATCH (q:Query { question: $question })
               MATCH (i:Issue { repo_id: $repoId, number: $num })
               MERGE (q)-[:CITES]->(i)`,
              { question, repoId, num: Number(citation.id) }
            );
          }
        }
      }
    } catch (err) {
      console.error('Recording Q&A history failed:', err);
    } finally {
      await session.close();
    }
  }

  async askQuestion(
    repoId: string,
    issueNumber: number,
    question: string
  ): Promise<{ answer: string | null; evidence_chain: EvidenceLink[] | null; refusal: boolean; reason?: string }> {
    if (!this.ai) {
      return {
        answer: 'Gemini reasoning service is not available (missing API Key).',
        evidence_chain: [],
        refusal: false,
      };
    }

    // 1. Identify targets
    const targets = await this.extractQueryTargets(question);
    
    // 2. Fetch Graph Data
    const graphData = await this.getGraphContext(repoId, targets.files, targets.functions);

    // 3. Strict verification: if graph context is empty, refuse to answer
    if (graphData.length === 0) {
      const refusalResult = {
        answer: null,
        evidence_chain: null,
        refusal: true,
        reason: 'no_complete_citation_chain',
      };
      await this.recordQuestionHistory(repoId, issueNumber, question, null, true, []);
      return refusalResult;
    }

    // 4. Grounded Q&A Generation
    try {
      const prompt = `You are an AI code assistant for OSS Sahayak.
We have retrieved the following structural graph database content relating to the question:
${JSON.stringify(graphData, null, 2)}

User Question: "${question}"

Instructions:
1. Answer the user's question clearly, grounding your explanation strictly in the code structural context and git history provided.
2. If the provided context does not support a full answer, or if you cannot trace a connection, return an empty answer and set refusal to true.
3. Identify the specific files, functions, commits, PRs, or issues you used to formulate the answer.
4. Format your response ONLY as a JSON object:
{
  "answer": "Your detailed markdown answer here...",
  "citations": [
    { "type": "File", "id": "src/auth.ts" },
    { "type": "Function", "id": "owner/name::src/auth.ts::validateUser::12" }
  ],
  "refusal": false
}
If you refuse to answer due to insufficient evidence, return:
{
  "answer": null,
  "citations": [],
  "refusal": true
}`;

      const response = await this.ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              answer: {
                type: Type.STRING,
                description: "Detailed markdown answer grounding explanation strictly in the code structural context and git history."
              },
              citations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    type: { type: Type.STRING, description: "Type of evidence: File, Function, Commit, PullRequest, or Issue." },
                    id: { type: Type.STRING, description: "Identifier of the evidence node." }
                  },
                  required: ["type", "id"]
                },
                description: "Specific files, functions, commits, PRs, or issues used to formulate the answer."
              },
              refusal: {
                type: Type.BOOLEAN,
                description: "Set to true if the provided context does not support a full answer, or if you cannot trace a connection."
              }
            },
            required: ["answer", "citations", "refusal"]
          }
        }
      });

      const parsed = cleanAndParseJSON(response.text || '{}');

      if (parsed.refusal) {
        await this.recordQuestionHistory(repoId, issueNumber, question, null, true, []);
        return {
          answer: null,
          evidence_chain: null,
          refusal: true,
          reason: 'no_complete_citation_chain',
        };
      }

      const answer = parsed.answer || 'No answer generated.';
      const citations: EvidenceLink[] = parsed.citations || [];

      // Write transaction to history
      await this.recordQuestionHistory(repoId, issueNumber, question, answer, false, citations);

      return {
        answer,
        evidence_chain: citations,
        refusal: false,
      };
    } catch (err) {
      console.error('Gemini answer generation failed:', err);
      return {
        answer: 'Failed to generate answer due to processing error.',
        evidence_chain: [],
        refusal: false,
      };
    }
  }
}
