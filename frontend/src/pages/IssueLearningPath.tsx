import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { LearningPathStep, LearningPathResponse } from 'shared';
import { BookOpen, HelpCircle, Code2, AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';

export const IssueLearningPath: React.FC = () => {
  const [repoId, setRepoId] = useState('');
  const [issues, setIssues] = useState<{ number: number; title: string }[]>([]);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [pathData, setPathData] = useState<LearningPathResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const savedRepoId = localStorage.getItem('repo_id');
    if (!savedRepoId) {
      setRepoId('');
      return;
    }
    setRepoId(savedRepoId);

    const fetchIssuesAndPath = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await axios.get(`/api/repos/${savedRepoId}/issues`);
        setIssues(res.data || []);
        if (res.data && res.data.length > 0) {
          const firstIssueNum = res.data[0].number;
          setSelectedIssue(firstIssueNum);
          const lpRes = await axios.get(`/api/learning-path?repo_id=${savedRepoId}&issue_number=${firstIssueNum}`);
          setPathData(lpRes.data);
        } else {
          setError('No open issues found for this repository.');
        }
      } catch (err: any) {
        console.error(err);
        setError(err.response?.data?.error?.message || 'Failed to fetch issues or learning path');
      } finally {
        setLoading(false);
      }
    };

    fetchIssuesAndPath();
  }, []);

  const fetchLearningPath = async (rid: string, issueNum: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`/api/learning-path?repo_id=${rid}&issue_number=${issueNum}`);
      setPathData(response.data);
    } catch (err: any) {
      console.error(err);
      setError(err.response?.data?.error?.message || 'Failed to fetch learning path');
    } finally {
      setLoading(false);
    }
  };

  const handleIssueChange = (issueNum: number) => {
    setSelectedIssue(issueNum);
    if (repoId) {
      fetchLearningPath(repoId, issueNum);
    }
  };

  const getStepIcon = (type: string) => {
    switch (type) {
      case 'File':
        return <Code2 size={18} style={{ color: 'var(--color-accent-graph)' }} />;
      case 'Function':
        return <BookOpen size={18} style={{ color: 'var(--color-accent-evidence)' }} />;
      default:
        return <HelpCircle size={18} />;
    }
  };

  const getActionLabel = (action: string) => {
    switch (action) {
      case 'read':
        return 'Read';
      case 'understand':
        return 'Understand';
      case 'edit':
        return 'Modify & Fix';
      default:
        return action;
    }
  };

  if (!repoId) {
    return (
      <div style={{ maxWidth: '600px', margin: 'var(--space-64) auto', padding: '0 var(--space-16)', textAlign: 'center' }}>
        <div className="card" style={{ borderColor: 'var(--color-accent-evidence)', padding: 'var(--space-32)' }}>
          <AlertTriangle size={48} style={{ color: 'var(--color-accent-evidence)', marginBottom: 'var(--space-16)' }} />
          <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-8)' }}>No Repository Registered</h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)', marginBottom: 'var(--space-24)' }}>
            Please onboard a repository first to build its evidence graph and view learning paths.
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
    <div style={{ maxWidth: '800px', margin: 'var(--space-32) auto', padding: '0 var(--space-16)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-24)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-h1)' }}>Learning Path</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)' }}>
            Codebase dependencies sorted topologically for Issue #{selectedIssue} (Repo: <span className="mono">{repoId}</span>)
          </p>
        </div>

        {/* Issue Picker */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
          <label style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>Select Issue:</label>
          <select
            value={selectedIssue || ''}
            onChange={e => handleIssueChange(Number(e.target.value))}
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: 'var(--radius-card)',
              padding: 'var(--space-8) var(--space-16)',
              outline: 'none',
            }}
          >
            {issues.map(issue => (
              <option key={issue.number} value={issue.number}>Issue #{issue.number}: {issue.title}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-48)' }}>
          <div className="mono animate-pulse">Calculating Dependency Subgraph...</div>
        </div>
      ) : error ? (
        <div className="card" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>
          <AlertTriangle size={24} />
          <div>{error}</div>
        </div>
      ) : pathData ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-24)' }}>
          {/* Seed Method Banner */}
          <div className="card flex items-center justify-between" style={{ padding: 'var(--space-12) var(--space-16)' }}>
            <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>
              Seed Finder Method: <span className="mono" style={{ color: 'var(--color-accent-evidence)', fontWeight: 'var(--weight-semibold)' }}>{pathData.seed_method || 'none'}</span>
            </div>
            
            {pathData.low_confidence && (
              <div 
                className="flex items-center gap-4 mono" 
                style={{ 
                  color: 'var(--color-danger)', 
                  fontSize: 'var(--text-caption)',
                  backgroundColor: 'rgba(217, 108, 108, 0.1)',
                  padding: 'var(--space-4) var(--space-8)',
                  borderRadius: 'var(--radius-pill)',
                }}
              >
                <AlertTriangle size={14} />
                <span>LOW CONFIDENCE</span>
              </div>
            )}
          </div>

          {/* Low Confidence Warning Description */}
          {pathData.low_confidence && pathData.seed_method === 'centrality_fallback_low_confidence' && (
            <div className="card" style={{ borderLeft: '4px solid var(--color-danger)', backgroundColor: 'rgba(217, 108, 108, 0.03)' }}>
              <h3 style={{ color: 'var(--color-danger)', fontSize: 'var(--text-h2)', marginBottom: 'var(--space-8)' }}>
                No strong starting point found
              </h3>
              <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', margin: 0 }}>
                We couldn't find an explicit file reference, a matching historical fix, or a frequently-touched file for this issue's labels. Showing the repo's most central files as a low-confidence starting point — verify these manually before relying on them.
              </p>
            </div>
          )}

          {/* Path Steps */}
          {pathData.path.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: 'var(--space-48)' }}>
              <h3 style={{ fontSize: 'var(--text-h2)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-8)' }}>Nothing to learn first</h3>
              <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', margin: 0 }}>
                This issue's seed files have no upstream dependencies within the configured hop depth. You can start directly with the seed file(s) listed below.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-16">
              {pathData.path.map((step, index) => (
                <div 
                  key={step.step}
                  className="card flex items-center justify-between"
                  style={{
                    borderLeft: `3px solid ${step.action === 'edit' ? 'var(--color-success)' : 'var(--color-accent-graph)'}`
                  }}
                >
                  <div className="flex items-center gap-16">
                    <div 
                      className="mono flex items-center justify-center"
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--color-bg-base)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        fontSize: '12px'
                      }}
                    >
                      {step.step}
                    </div>
                    <div>
                      <div className="flex items-center gap-8">
                        {getStepIcon(step.type)}
                        <span className="mono" style={{ fontWeight: 'var(--weight-semibold)' }}>{step.id}</span>
                      </div>
                      <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-4)' }}>
                        Action: <span style={{ color: step.action === 'edit' ? 'var(--color-success)' : 'var(--color-text-primary)' }}>{getActionLabel(step.action)}</span>
                      </div>
                    </div>
                  </div>

                  <Link 
                    to={`/qa-chat?file=${encodeURIComponent(step.id)}&issue=${selectedIssue}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-4)',
                      fontSize: 'var(--text-caption)',
                      color: 'var(--color-accent-graph)',
                    }}
                  >
                    <span>Ask about this</span>
                    <ArrowRight size={14} />
                  </Link>
                </div>
              ))}
            </div>
          )}

          {/* Action Footer */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-16)' }}>
            <Link
              to={`/qa-chat?issue=${selectedIssue}`}
              style={{
                backgroundColor: 'var(--color-accent-evidence)',
                color: 'var(--color-bg-base)',
                borderRadius: 'var(--radius-card)',
                padding: 'var(--space-12) var(--space-24)',
                fontWeight: 'var(--weight-semibold)',
              }}
            >
              Start Codebase Q&A Chat
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
};
