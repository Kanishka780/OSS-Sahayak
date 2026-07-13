import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GITHUB_API_BASE = 'https://api.github.com';

export interface GitHubFile {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
}

export interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
  author: {
    login: string;
  } | null;
  files?: {
    filename: string;
    additions: number;
    deletions: number;
  }[];
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  created_at: string;
  merged_at: string | null;
  user: {
    login: string;
  };
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  created_at: string;
  labels: { name: string }[];
  pull_request?: any; // If present, this is actually a PR, not a pure issue
}

export interface GitHubReview {
  user: {
    login: string;
  };
  state: string;
}

export class GitHubClient {
  private token: string | undefined;
  private owner: string;
  private repo: string;

  constructor(repoId: string) {
    this.token = process.env.GITHUB_TOKEN;
    const parts = repoId.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid repo_id: ${repoId}. Expected format: 'owner/name'`);
    }
    this.owner = parts[0];
    this.repo = parts[1];
  }

  private get headers() {
    const hdrs: Record<string, string> = {
      'User-Agent': 'OSS-Sahayak-App',
      'Accept': 'application/vnd.github.v3+json',
    };
    if (this.token) {
      hdrs['Authorization'] = `token ${this.token}`;
    }
    return hdrs;
  }

  async getRepoMetadata(): Promise<{ default_branch: string }> {
    const url = `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}`;
    const response = await axios.get(url, { headers: this.headers });
    return {
      default_branch: response.data.default_branch || 'main',
    };
  }

  async getFileTree(branch: string): Promise<GitHubFile[]> {
    const url = `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}/git/trees/${branch}?recursive=1`;
    const response = await axios.get(url, { headers: this.headers });
    return response.data.tree || [];
  }

  async getFileContent(path: string): Promise<string> {
    const url = `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}/contents/${path}`;
    const response = await axios.get(url, { headers: this.headers });
    if (response.data.encoding === 'base64') {
      return Buffer.from(response.data.content, 'base64').toString('utf-8');
    }
    return response.data.content;
  }

  async getCommits(limit = 100): Promise<GitHubCommit[]> {
    const url = `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}/commits?per_page=${limit}`;
    const response = await axios.get(url, { headers: this.headers });
    const commits = response.data || [];
    
    // For the first few commits, fetch full details (including modified files)
    // To stay safe from rate limits in a demo, we only fetch file details for the top 30 commits
    const detailedCommits: GitHubCommit[] = [];
    for (let i = 0; i < Math.min(commits.length, 30); i++) {
      try {
        const detailUrl = `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}/commits/${commits[i].sha}`;
        const detailResponse = await axios.get(detailUrl, { headers: this.headers });
        const data = detailResponse.data;
        detailedCommits.push({
          sha: data.sha,
          commit: {
            message: data.commit?.message || '',
            author: {
              name: data.commit?.author?.name || 'Unknown Contributor',
              date: data.commit?.author?.date || new Date().toISOString(),
            }
          },
          author: data.author ? { login: data.author.login } : null,
          files: data.files ? data.files.map((f: any) => ({
            filename: f.filename,
            additions: f.additions || 0,
            deletions: f.deletions || 0,
          })) : []
        });
      } catch (err) {
        // Fallback to basic commit details if rate-limited or fails
        const c = commits[i];
        detailedCommits.push({
          sha: c.sha,
          commit: {
            message: c.commit?.message || '',
            author: {
              name: c.commit?.author?.name || 'Unknown Contributor',
              date: c.commit?.author?.date || new Date().toISOString(),
            }
          },
          author: c.author ? { login: c.author.login } : null
        });
      }
    }
    
    // Add the rest as basic commit details
    for (let i = 30; i < commits.length; i++) {
      const c = commits[i];
      detailedCommits.push({
        sha: c.sha,
        commit: {
          message: c.commit?.message || '',
          author: {
            name: c.commit?.author?.name || 'Unknown Contributor',
            date: c.commit?.author?.date || new Date().toISOString(),
          }
        },
        author: c.author ? { login: c.author.login } : null
      });
    }

    return detailedCommits;
  }

  async getPRs(limit = 50): Promise<GitHubPR[]> {
    const url = `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}/pulls?state=all&per_page=${limit}`;
    const response = await axios.get(url, { headers: this.headers });
    const prs = response.data || [];
    return prs.map((pr: any) => ({
      number: pr.number,
      title: pr.title || '',
      body: pr.body || '',
      state: pr.state,
      created_at: pr.created_at,
      merged_at: pr.merged_at || null,
      user: pr.user ? { login: pr.user.login } : { login: 'unknown-contributor' }
    }));
  }

  async getIssues(limit = 50): Promise<GitHubIssue[]> {
    const url = `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}/issues?state=all&per_page=${limit}`;
    const response = await axios.get(url, { headers: this.headers });
    const issues = response.data || [];
    // Filter out pull requests from the issues list since GitHub API merges them
    const filteredIssues = issues.filter((issue: any) => !issue.pull_request);
    return filteredIssues.map((issue: any) => ({
      number: issue.number,
      title: issue.title || '',
      body: issue.body || '',
      state: issue.state,
      created_at: issue.created_at,
      labels: issue.labels ? issue.labels.map((l: any) => ({ name: l.name })) : []
    }));
  }

  async getPRReviews(prNumber: number): Promise<GitHubReview[]> {
    try {
      const url = `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`;
      const response = await axios.get(url, { headers: this.headers });
      const reviews = response.data || [];
      return reviews.map((rev: any) => ({
        user: rev.user ? { login: rev.user.login } : { login: 'unknown-contributor' },
        state: rev.state
      }));
    } catch (err) {
      return [];
    }
  }
}
