import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { IngestionStatus } from 'shared';
import { GitBranch, RefreshCw, AlertTriangle, CheckCircle, Database } from 'lucide-react';

export const RepoOnboarding: React.FC = () => {
  const [repoUrl, setRepoUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<IngestionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl) return;

    setLoading(true);
    setError(null);
    try {
      const response = await axios.post('/api/repos', { repo_url: repoUrl });
      const data = response.data;
      
      // Start polling
      pollStatus(data.repo_id);
    } catch (err: any) {
      console.error(err);
      setError(err.response?.data?.error?.message || 'Failed to register repository');
      setLoading(false);
    }
  };

  const pollStatus = (repoId: string) => {
    let consecutive404s = 0;
    const max404s = 15; // 30 seconds

    const interval = setInterval(async () => {
      try {
        const response = await axios.get(`/api/repos/${repoId}/status`);
        const data: IngestionStatus = response.data;
        setStatus(data);
        setError(null);

        if (data.status === 'ready' || data.status === 'failed') {
          clearInterval(interval);
          setLoading(false);
          if (data.status === 'ready') {
            // Save repoId in local storage for navigation context
            localStorage.setItem('repo_id', repoId);
            setTimeout(() => {
              navigate('/learning-path');
            }, 1500);
          } else if (data.status === 'failed') {
            setError('Ingestion failed. Please check backend server logs.');
          }
        }
      } catch (err: any) {
        const status = err.response?.status;
        if (status === 404 && consecutive404s < max404s) {
          consecutive404s++;
          return;
        }

        clearInterval(interval);
        setLoading(false);
        const errMsg = err.response?.data?.error?.message || err.message || 'Status polling failed';
        setError(status === 404 ? 'Repository failed to register or initialize in 30 seconds' : errMsg);
      }
    }, 2000);
  };

  return (
    <div style={{ maxWidth: '600px', margin: 'var(--space-64) auto', padding: '0 var(--space-16)' }}>
      <div style={{ textAlign: 'center', marginBottom: 'var(--space-48)' }}>
        <h1 style={{ fontSize: 'var(--text-display-xl)', marginBottom: 'var(--space-8)' }}>OSS Sahayak</h1>
        <p style={{ color: 'var(--color-text-secondary)' }}>
          Developer Trust Infrastructure. Reconstruct codebase context from history.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 'var(--space-24)' }}>
        <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-16)' }}>Register Repository</h2>
        <form onSubmit={handleRegister}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-12)' }}>
            <input
              type="text"
              placeholder="https://github.com/owner/repository"
              value={repoUrl}
              onChange={e => setRepoUrl(e.target.value)}
              disabled={loading}
              style={{
                backgroundColor: 'var(--color-bg-base)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: 'var(--radius-card)',
                padding: 'var(--space-12)',
                color: 'var(--color-text-primary)',
                outline: 'none',
              }}
            />
            {error && <div style={{ color: 'var(--color-danger)', fontSize: 'var(--text-caption)' }}>{error}</div>}
            
            <button
              type="submit"
              disabled={loading || !repoUrl}
              style={{
                backgroundColor: 'var(--color-accent-graph)',
                color: 'var(--color-bg-base)',
                border: 'none',
                borderRadius: 'var(--radius-card)',
                padding: 'var(--space-12)',
                fontWeight: 'var(--weight-semibold)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--space-8)',
                opacity: loading || !repoUrl ? 0.6 : 1,
              }}
            >
              {loading && <RefreshCw className="animate-spin" size={16} />}
              <span>{loading ? 'Ingesting Repository...' : 'Onboard Repository'}</span>
            </button>
          </div>
        </form>
      </div>

      {status && (
        <div className="card" style={{ border: `1px solid ${status.status === 'ready' ? 'var(--color-success)' : 'var(--color-accent-graph)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-12)' }}>
            {status.status === 'ingesting' && <Database className="animate-pulse" style={{ color: 'var(--color-accent-graph)' }} />}
            {status.status === 'ready' && <CheckCircle style={{ color: 'var(--color-success)' }} />}
            {status.status === 'failed' && <AlertTriangle style={{ color: 'var(--color-danger)' }} />}
            
            <div>
              <div className="mono" style={{ fontWeight: 'var(--weight-semibold)' }}>{status.repo_id}</div>
              <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-4)' }}>
                Status: <span className="mono" style={{ color: status.status === 'ready' ? 'var(--color-success)' : 'var(--color-accent-evidence)' }}>{status.status.toUpperCase()}</span>
              </div>
              {status.file_count !== undefined && (
                <div className="mono" style={{ fontSize: 'var(--text-caption)', marginTop: 'var(--space-4)' }}>
                  Files Found: {status.file_count}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Empty State Description */}
      {!status && !loading && (
        <div style={{ textAlign: 'center', marginTop: 'var(--space-48)', opacity: 0.6 }}>
          <h3 style={{ fontSize: 'var(--text-h2)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-8)' }}>Not ingested yet</h3>
          <p style={{ fontSize: 'var(--text-caption)' }}>
            This repository hasn't been indexed. Register it to start building its evidence graph — ingestion runs in the background.
          </p>
        </div>
      )}
    </div>
  );
};
