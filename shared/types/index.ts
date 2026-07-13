// Graph Database Nodes
export interface RepositoryNode {
  repo_id: string; // owner/name
  owner: string;
  name: string;
  default_branch: string;
  last_ingested_commit_hash?: string;
  last_ingested_at?: string;
  file_count?: number;
  loc_count?: number;
  ingestion_status: 'pending' | 'ingesting' | 'ready' | 'failed';
  unresolved_edges_count?: number;
}

export interface FileNode {
  repo_id: string;
  path: string;
  language: string; // ts | tsx | js | jsx
  loc: number;
  in_degree_centrality: number;
}

export interface FunctionNode {
  function_id: string; // repo_id + file_path + name + start_line
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  in_degree_centrality: number;
}

export interface ClassNode {
  class_id: string;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
}

export interface CommitNode {
  repo_id: string;
  hash: string;
  message: string;
  timestamp: string;
}

export interface PullRequestNode {
  repo_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  created_at: string;
  merged_at?: string;
}

export interface IssueNode {
  repo_id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  created_at: string;
}

export interface ContributorNode {
  github_login: string;
  display_name: string;
}

// AST Extraction structures
export interface ImportDetails {
  importPath: string;
  specifiers: string[];
}

export interface CallDetails {
  callee: string;
  line: number;
}

export interface ParsedFile {
  path: string;
  loc: number;
  imports: ImportDetails[];
  functions: {
    name: string;
    startLine: number;
    endLine: number;
    calls: CallDetails[];
  }[];
  classes: {
    name: string;
    superClass?: string;
    startLine: number;
    endLine: number;
  }[];
}

// Ingestion Worker Status Types
export interface IngestionStatus {
  repo_id: string;
  status: 'pending' | 'ingesting' | 'ready' | 'failed';
  last_ingested_commit_hash?: string;
  last_ingested_at?: string;
  file_count?: number;
  unresolved_edges_count?: number;
}

// API Request/Response Types
export interface RepoRegisterRequest {
  repo_url: string;
}

export interface RepoRegisterResponse {
  repo_id: string;
  status: 'ingesting' | 'ready';
  registered_at: string;
  scope_warning?: boolean;
}

export interface AskRequest {
  repo_id: string;
  issue_number: number;
  question: string;
  input_mode: 'text' | 'voice';
  output_language: 'en' | 'hi-en';
}

export interface EvidenceLink {
  type: 'Issue' | 'PullRequest' | 'Commit' | 'File' | 'Function';
  id: string | number;
}

export interface AskResponse {
  answer: string | null;
  evidence_chain: EvidenceLink[] | null;
  refusal: boolean;
  reason?: string;
  audio_url?: string; // Voice synthesized response if requested
}

export interface LearningPathStep {
  step: number;
  type: 'File' | 'Function' | 'PullRequest' | 'Issue';
  id: string;
  action: 'read' | 'understand' | 'edit';
}

export interface LearningPathResponse {
  issue_number: number;
  path: LearningPathStep[];
  seed_method: 'explicit_mention' | 'label_matched_historical_fix' | 'frequent_by_label' | 'centrality_fallback_low_confidence' | null;
  low_confidence: boolean;
  reason?: string;
}

export interface ReadinessReportResponse {
  issue_number: number;
  generated_at: string;
  repo_commit_hash: string;
  exploration_coverage: number;
  evidence_coverage: number;
  dependency_coverage: number;
  missing_critical_nodes: {
    name: string;
    reason: string;
  }[];
  suggested_reviewer: {
    login: string;
    score: number;
  } | null;
}

export interface ReviewerCandidate {
  login: string;
  score: number;
  factors: {
    commit_frequency: number;
    recency_decayed_activity: number;
    ownership_share: number;
    review_comment_count: number;
  };
}

export interface ReviewerRecommendationResponse {
  candidates: ReviewerCandidate[];
}
