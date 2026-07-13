import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { RepoOnboarding } from './pages/RepoOnboarding';
import { IssueLearningPath } from './pages/IssueLearningPath';
import { QAChat } from './pages/QAChat';
import { ReadinessReport } from './pages/ReadinessReport';
import { MaintainerReview } from './pages/MaintainerReview';
import './styles/tokens.css';
import './styles/typography.css';

const Navigation: React.FC = () => {
  const location = useLocation();

  const isActive = (path: string) => {
    return location.pathname === path ? 'nav-link-active' : '';
  };

  return (
    <nav style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 'var(--space-16) var(--space-32)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
      backgroundColor: 'var(--color-bg-surface)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
        <div style={{
          width: '12px',
          height: '12px',
          borderRadius: '50%',
          backgroundColor: 'var(--color-accent-evidence)',
          boxShadow: '0 0 6px var(--color-accent-evidence)'
        }}></div>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-h2)', fontWeight: 'var(--weight-semibold)', letterSpacing: '-0.5px' }}>
          OSS Sahayak
        </span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-24)', fontSize: 'var(--text-caption)' }}>
        <Link to="/" className={isActive('/')} style={{ color: 'inherit', fontWeight: 'var(--weight-medium)' }}>Onboard</Link>
        <Link to="/learning-path" className={isActive('/learning-path')} style={{ color: 'inherit', fontWeight: 'var(--weight-medium)' }}>Learning Path</Link>
        <Link to="/qa-chat" className={isActive('/qa-chat')} style={{ color: 'inherit', fontWeight: 'var(--weight-medium)' }}>Q&A Chat</Link>
        <Link to="/readiness-report" className={isActive('/readiness-report')} style={{ color: 'inherit', fontWeight: 'var(--weight-medium)' }}>Readiness Report</Link>
        <Link to="/maintainer-review" className={isActive('/maintainer-review')} style={{ color: 'inherit', fontWeight: 'var(--weight-medium)' }}>Reviewer View</Link>
      </div>
    </nav>
  );
};

export const App: React.FC = () => {
  return (
    <Router>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', backgroundColor: 'var(--color-bg-base)' }}>
        <Navigation />
        <main style={{ flexGrow: 1, padding: 'var(--space-32) 0' }}>
          <Routes>
            <Route path="/" element={<RepoOnboarding />} />
            <Route path="/learning-path" element={<IssueLearningPath />} />
            <Route path="/qa-chat" element={<QAChat />} />
            <Route path="/readiness-report" element={<ReadinessReport />} />
            <Route path="/maintainer-review" element={<MaintainerReview />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
};
export default App;
