import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { ReadinessReportResponse } from 'shared';
import { AlertCircle, AlertTriangle, CheckCircle, ChevronDown, ChevronUp, FileCode, Users, HelpCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

export const ReadinessReport: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [repoId, setRepoId] = useState('');
  const [issueNumber, setIssueNumber] = useState(42);
  const [report, setReport] = useState<ReadinessReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Formula disclosure toggle states
  const [showFormula, setShowFormula] = useState<Record<string, boolean>>({
    exploration: false,
    evidence: false,
    dependency: false
  });

  useEffect(() => {
    const savedRepoId = localStorage.getItem('repo_id');
    if (!savedRepoId) {
      setRepoId('');
      return;
    }
    setRepoId(savedRepoId);

    const issueParam = searchParams.get('issue');
    if (issueParam) {
      setIssueNumber(Number(issueParam));
    }

    fetchReport(savedRepoId, issueParam ? Number(issueParam) : 42);
  }, [searchParams]);

  const fetchReport = async (rid: string, issueNum: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`/api/reports/readiness?repo_id=${rid}&issue_number=${issueNum}`);
      setReport(response.data);
    } catch (err: any) {
      console.error(err);
      setError(err.response?.data?.error?.message || 'Failed to generate readiness report');
    } finally {
      setLoading(false);
    }
  };

  const getMetricColor = (val: number) => {
    if (val < 0.4) return 'var(--color-danger)';
    if (val < 0.75) return 'var(--color-accent-evidence)';
    return 'var(--color-success)';
  };

  const toggleFormula = (metric: string) => {
    setShowFormula(prev => ({ ...prev, [metric]: !prev[metric] }));
  };

  if (!repoId) {
    return (
      <div style={{ maxWidth: '600px', margin: 'var(--space-64) auto', padding: '0 var(--space-16)', textAlign: 'center' }}>
        <div className="card" style={{ borderColor: 'var(--color-accent-evidence)', padding: 'var(--space-32)' }}>
          <AlertTriangle size={48} style={{ color: 'var(--color-accent-evidence)', marginBottom: 'var(--space-16)' }} />
          <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-8)' }}>No Repository Registered</h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)', marginBottom: 'var(--space-24)' }}>
            Please onboard a repository first to build its evidence graph and generate readiness reports.
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-32)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-h1)' }}>Contribution Readiness Report</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)' }}>
            Verifiable proof-of-exploration signals for Issue #{issueNumber}
          </p>
        </div>
        <Link
          to={`/maintainer-review?issue=${issueNumber}`}
          style={{
            border: '1px solid var(--color-accent-graph)',
            color: 'var(--color-accent-graph)',
            padding: 'var(--space-8) var(--space-16)',
            borderRadius: 'var(--radius-card)',
            fontSize: 'var(--text-caption)',
            fontWeight: 'var(--weight-semibold)',
          }}
        >
          Maintainer Dashboard
        </Link>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-48)' }}>
          <div className="mono animate-pulse">Computing Graph Coverage Matrices...</div>
        </div>
      ) : error ? (
        <div className="card" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>
          <AlertCircle size={24} />
          <div>{error}</div>
        </div>
      ) : report ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-24)' }}>
          
          {/* Metadata Header Card */}
          <div className="card">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-16)' }}>
              <div>
                <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>Repository Commit</div>
                <div className="mono" style={{ fontWeight: 'var(--weight-semibold)', marginTop: 'var(--space-4)' }}>{report.repo_commit_hash.slice(0, 8)}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>Generated At</div>
                <div className="mono" style={{ fontWeight: 'var(--weight-semibold)', marginTop: 'var(--space-4)' }}>
                  {new Date(report.generated_at).toLocaleString()}
                </div>
              </div>
            </div>
          </div>

          {/* Coverage Metrics section */}
          <div className="card">
            <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-16)' }}>Coverage Metrics</h2>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-24)' }}>
              {/* Exploration Coverage */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-8)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                    <span>Exploration Coverage</span>
                    <button onClick={() => toggleFormula('exploration')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
                      <HelpCircle size={14} />
                    </button>
                  </div>
                  <span className="mono" style={{ color: getMetricColor(report.exploration_coverage), fontWeight: 'var(--weight-semibold)' }}>
                    {(report.exploration_coverage * 100).toFixed(0)}%
                  </span>
                </div>
                <div style={{ height: '8px', backgroundColor: 'var(--color-bg-base)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
                  <div style={{ width: `${report.exploration_coverage * 100}%`, height: '100%', backgroundColor: getMetricColor(report.exploration_coverage) }}></div>
                </div>
                {showFormula.exploration && (
                  <div className="mono" style={{ backgroundColor: 'var(--color-bg-base)', padding: 'var(--space-8)', borderRadius: 'var(--radius-pill)', fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: 'var(--space-8)' }}>
                    Formula: Exploration Coverage = Σ(weights of explored nodes) / Σ(weights of relevant nodes in the issue's dependency subgraph)
                  </div>
                )}
              </div>

              {/* Evidence Coverage */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-8)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                    <span>Evidence Coverage</span>
                    <button onClick={() => toggleFormula('evidence')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
                      <HelpCircle size={14} />
                    </button>
                  </div>
                  <span className="mono" style={{ color: getMetricColor(report.evidence_coverage), fontWeight: 'var(--weight-semibold)' }}>
                    {(report.evidence_coverage * 100).toFixed(0)}%
                  </span>
                </div>
                <div style={{ height: '8px', backgroundColor: 'var(--color-bg-base)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
                  <div style={{ width: `${report.evidence_coverage * 100}%`, height: '100%', backgroundColor: getMetricColor(report.evidence_coverage) }}></div>
                </div>
                {showFormula.evidence && (
                  <div className="mono" style={{ backgroundColor: 'var(--color-bg-base)', padding: 'var(--space-8)', borderRadius: 'var(--radius-pill)', fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: 'var(--space-8)' }}>
                    Formula: Evidence Coverage = (# of Q&A answers with a complete citation chain) / (total # of Q&A answers)
                  </div>
                )}
              </div>

              {/* Dependency Coverage */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-8)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                    <span>Dependency Coverage</span>
                    <button onClick={() => toggleFormula('dependency')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
                      <HelpCircle size={14} />
                    </button>
                  </div>
                  <span className="mono" style={{ color: getMetricColor(report.dependency_coverage), fontWeight: 'var(--weight-semibold)' }}>
                    {(report.dependency_coverage * 100).toFixed(0)}%
                  </span>
                </div>
                <div style={{ height: '8px', backgroundColor: 'var(--color-bg-base)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
                  <div style={{ width: `${report.dependency_coverage * 100}%`, height: '100%', backgroundColor: getMetricColor(report.dependency_coverage) }}></div>
                </div>
                {showFormula.dependency && (
                  <div className="mono" style={{ backgroundColor: 'var(--color-bg-base)', padding: 'var(--space-8)', borderRadius: 'var(--radius-pill)', fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: 'var(--space-8)' }}>
                    Formula: Dependency Coverage = (# of nodes touched during exploration that are within the depth-2 blast-radius subgraph) / (total # of nodes in the depth-2 blast-radius subgraph)
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Missing Critical Nodes */}
          <div className="card">
            <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-16)' }}>Missing Critical Nodes</h2>
            {report.missing_critical_nodes.length === 0 ? (
              <div className="flex items-center gap-8" style={{ color: 'var(--color-success)', fontSize: 'var(--text-caption)' }}>
                <CheckCircle size={16} />
                <span>No missing critical nodes identified. Complete exploration verified!</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-12)' }}>
                {report.missing_critical_nodes.map((node, index) => (
                  <div key={index} style={{ borderLeft: '3px solid var(--color-danger)', paddingLeft: 'var(--space-12)' }}>
                    <div className="mono" style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--color-danger)' }}>
                      {node.name}
                    </div>
                    <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-4)' }}>
                      {node.reason}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Suggested Reviewer */}
          {report.suggested_reviewer && (
            <div className="card">
              <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-16)' }}>Suggested Reviewer</h2>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-12)' }}>
                  <div style={{ backgroundColor: 'var(--color-bg-base)', padding: 'var(--space-8)', borderRadius: '50%' }}>
                    <Users style={{ color: 'var(--color-accent-graph)' }} />
                  </div>
                  <div>
                    <div className="mono" style={{ fontWeight: 'var(--weight-semibold)' }}>{report.suggested_reviewer.login}</div>
                    <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-4)' }}>
                      Highest domain ownership share
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="mono" style={{ color: 'var(--color-accent-graph)', fontSize: 'var(--text-h2)', fontWeight: 'var(--weight-semibold)' }}>
                    {report.suggested_reviewer.score.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-4)' }}>
                    Relevance Score
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      ) : null}
    </div>
  );
};
