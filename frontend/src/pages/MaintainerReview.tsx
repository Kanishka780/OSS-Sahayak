import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useSearchParams, Link } from 'react-router-dom';
import { ReviewerCandidate } from 'shared';
import { Link2, AlertTriangle, Users } from 'lucide-react';

export const MaintainerReview: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [repoId, setRepoId] = useState('');
  const [issueNumber, setIssueNumber] = useState(42);
  const [candidates, setCandidates] = useState<ReviewerCandidate[]>([]);
  const [candidatePoolSize, setCandidatePoolSize] = useState<number>(0);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const savedRepoId = localStorage.getItem('repo_id');
    if (!savedRepoId) {
      setRepoId('');
      return;
    }
    setRepoId(savedRepoId);

    const issueParam = searchParams.get('issue');
    const currentIssue = issueParam ? Number(issueParam) : 42;
    setIssueNumber(currentIssue);

    fetchLearningPathAndReviewers(savedRepoId, currentIssue);
  }, [searchParams]);

  const fetchLearningPathAndReviewers = async (rid: string, issueNum: number) => {
    setLoading(true);
    setError(null);
    try {
      // 1. Fetch learning path
      const lpResponse = await axios.get(`/api/learning-path?repo_id=${rid}&issue_number=${issueNum}`);
      const pathSteps = lpResponse.data.path || [];
      const fileSteps = pathSteps.filter((step: any) => step.type === 'File');
      
      if (fileSteps.length === 0) {
        setError('No file steps found in the learning path for this issue.');
        setCandidates([]);
        setFiles([]);
        setCandidatePoolSize(0);
        return;
      }
      
      const filePaths: string[] = fileSteps.map((step: any) => step.id);
      setFiles(filePaths);

      // 2. Fetch reviewers
      const fileQuery = filePaths.map(f => `file_paths=${encodeURIComponent(f)}`).join('&');
      const response = await axios.get(`/api/reviewer-recommendation?repo_id=${rid}&${fileQuery}&issue_number=${issueNum}`);
      setCandidates(response.data.candidates || []);
      setCandidatePoolSize(response.data.candidate_pool_size ?? 0);
    } catch (err: any) {
      console.error(err);
      setError(err.response?.data?.error?.message || 'Failed to fetch learning path or reviewer suggestions');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = () => {
    const shareUrl = `${window.location.origin}/readiness-report?issue=${issueNumber}`;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!repoId) {
    return (
      <div style={{ maxWidth: '600px', margin: 'var(--space-64) auto', padding: '0 var(--space-16)', textAlign: 'center' }}>
        <div className="card" style={{ borderColor: 'var(--color-accent-evidence)', padding: 'var(--space-32)' }}>
          <AlertTriangle size={48} style={{ color: 'var(--color-accent-evidence)', marginBottom: 'var(--space-16)' }} />
          <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-8)' }}>No Repository Registered</h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)', marginBottom: 'var(--space-24)' }}>
            Please onboard a repository first to build its evidence graph and view suggested reviewers.
          </p>
          <Link to="/" style={{
            backgroundColor: 'var(--color-accent-graph)',
            color: 'var(--color-bg-base)',
            padding: 'var(--space-8) var(--space-16)',
            borderRadius: 'var(--radius-card)',
            fontWeight: 'var(--weight-semibold)',
            textDecoration: 'none',
            display: 'inline-block'
          }}>
            Onboard Repository
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '900px', margin: 'var(--space-32) auto', padding: '0 var(--space-16)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-32)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-h1)' }}>Maintainer Review Dashboard</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)' }}>
            Suggested reviewers for contributions resolving Issue #{issueNumber} based on file history and activity.
          </p>
        </div>

        {/* Copy Report Link */}
        <button
          onClick={handleCopyLink}
          style={{
            backgroundColor: 'var(--color-accent-evidence)',
            color: 'var(--color-bg-base)',
            border: 'none',
            borderRadius: 'var(--radius-card)',
            padding: 'var(--space-8) var(--space-16)',
            fontSize: 'var(--text-caption)',
            fontWeight: 'var(--weight-semibold)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
          }}
        >
          <Link2 size={14} />
          <span>{copied ? 'Copied Share Link!' : 'Share Readiness Report'}</span>
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-48)' }}>
          <div className="mono animate-pulse">Calculating Contributor Commits and Recency Decay...</div>
        </div>
      ) : error ? (
        <div className="card" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>
          <AlertTriangle size={24} />
          <div>{error}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-24)' }}>
          
          {/* Touched Files Context */}
          <div className="card">
            <h3 style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-8)' }}>Touched Files</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
              {files.map(file => (
                <span key={file} className="mono" style={{ backgroundColor: 'var(--color-bg-base)', padding: 'var(--space-4) var(--space-8)', borderRadius: 'var(--radius-pill)', fontSize: '12px' }}>
                  {file}
                </span>
              ))}
            </div>
          </div>

          {candidatePoolSize < 2 && (
            <div className="card" style={{ borderColor: 'var(--color-accent-evidence)', display: 'flex', alignItems: 'center', gap: 'var(--space-12)' }}>
              <AlertTriangle style={{ color: 'var(--color-accent-evidence)' }} />
              <div>
                <strong style={{ color: 'var(--color-accent-evidence)' }}>Low Confidence Recommendation:</strong> Only {candidatePoolSize} reviewer candidate found in pool. A single candidate does not provide a robust basis for recommendation.
              </div>
            </div>
          )}

          {/* Reviewer candidates table card */}
          <div className="card" style={{ overflowX: 'auto' }}>
            <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-16)' }}>Reviewer Candidates</h2>
            
            {candidates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 'var(--space-24)', color: 'var(--color-text-secondary)' }}>
                <Users size={32} style={{ marginBottom: 'var(--space-8)' }} />
                <div>No candidates found with commit history on these files.</div>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>
                    <th style={{ padding: 'var(--space-12) 0' }}>Reviewer</th>
                    <th>Commit Freq</th>
                    <th>Recency</th>
                    <th>Ownership Share</th>
                    <th>PR Comments</th>
                    <th style={{ textAlign: 'right' }}>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map(candidate => (
                    <tr key={candidate.login} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                      <td style={{ padding: 'var(--space-16) 0', fontWeight: 'var(--weight-semibold)' }}>{candidate.login}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                          <div style={{ width: '50px', height: '6px', backgroundColor: 'var(--color-bg-base)', borderRadius: 'var(--radius-pill)' }}>
                            <div style={{ width: `${candidate.factors.commit_frequency * 100}%`, height: '100%', backgroundColor: 'var(--color-accent-graph)', borderRadius: 'var(--radius-pill)' }}></div>
                          </div>
                          <span className="mono" style={{ fontSize: '12px' }}>{candidate.factors.commit_frequency.toFixed(2)}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                          <div style={{ width: '50px', height: '6px', backgroundColor: 'var(--color-bg-base)', borderRadius: 'var(--radius-pill)' }}>
                            <div style={{ width: `${candidate.factors.recency_decayed_activity * 100}%`, height: '100%', backgroundColor: 'var(--color-accent-graph)', borderRadius: 'var(--radius-pill)' }}></div>
                          </div>
                          <span className="mono" style={{ fontSize: '12px' }}>{candidate.factors.recency_decayed_activity.toFixed(2)}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                          <div style={{ width: '50px', height: '6px', backgroundColor: 'var(--color-bg-base)', borderRadius: 'var(--radius-pill)' }}>
                            <div style={{ width: `${candidate.factors.ownership_share * 100}%`, height: '100%', backgroundColor: 'var(--color-accent-graph)', borderRadius: 'var(--radius-pill)' }}></div>
                          </div>
                          <span className="mono" style={{ fontSize: '12px' }}>{candidate.factors.ownership_share.toFixed(2)}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                          <div style={{ width: '50px', height: '6px', backgroundColor: 'var(--color-bg-base)', borderRadius: 'var(--radius-pill)' }}>
                            <div style={{ width: `${candidate.factors.review_comment_count * 100}%`, height: '100%', backgroundColor: 'var(--color-accent-graph)', borderRadius: 'var(--radius-pill)' }}></div>
                          </div>
                          <span className="mono" style={{ fontSize: '12px' }}>{candidate.factors.review_comment_count.toFixed(2)}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 'var(--weight-semibold)' }} className="mono">
                        {candidate.score.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Formula disclosure */}
          <div className="card">
            <h3 style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-8)' }}>Reviewer Recommendation Formula</h3>
            <div className="mono" style={{ fontSize: '12px', color: 'var(--color-text-secondary)', backgroundColor: 'var(--color-bg-base)', padding: 'var(--space-12)', borderRadius: 'var(--radius-card)' }}>
              Score = 0.3 · Commit Frequency (touched files) + 0.2 · Recency-decayed activity + 0.3 · Ownership share of history + 0.2 · Reviews on related PRs
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
