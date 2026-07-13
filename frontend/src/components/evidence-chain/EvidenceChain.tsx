import React, { useEffect, useState } from 'react';
import { EvidenceLink } from 'shared';
import './EvidenceChain.css';

interface EvidenceChainProps {
  chain: EvidenceLink[] | null;
  animate?: boolean;
}

export const EvidenceChain: React.FC<EvidenceChainProps> = ({ chain, animate = true }) => {
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    if (!chain) return;

    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisibleCount(chain.length);
      return;
    }

    setVisibleCount(0);
    const interval = setInterval(() => {
      setVisibleCount(prev => {
        if (prev >= chain.length) {
          clearInterval(interval);
          return prev;
        }
        return prev + 1;
      });
    }, 300);

    return () => clearInterval(interval);
  }, [chain, animate]);

  if (!chain || chain.length === 0) {
    return (
      <div className="evidence-chain-empty mono">
        [Empty Evidence Chain]
      </div>
    );
  }

  const formatNodeLabel = (node: EvidenceLink) => {
    switch (node.type) {
      case 'Issue':
        return `Issue #${node.id}`;
      case 'PullRequest':
        return `PR #${node.id}`;
      case 'Commit':
        return `Commit ${String(node.id).slice(0, 7)}`;
      case 'File':
        return String(node.id).split('/').pop() || String(node.id);
      case 'Function':
        return `${String(node.id).split('::').pop()}()`;
      default:
        return `${node.type}: ${node.id}`;
    }
  };

  return (
    <div className="evidence-chain flex items-center">
      {chain.slice(0, visibleCount).map((node, index) => (
        <React.Fragment key={index}>
          {index > 0 && (
            <div className="evidence-connector animate-fade-in">
              <div className="connector-line"></div>
              <div className="connector-arrow">→</div>
            </div>
          )}
          <div 
            className="evidence-pill mono animate-fade-in"
            title={`${node.type}: ${node.id}`}
          >
            <span className="pill-type">{node.type.substring(0, 3)}:</span>
            <span className="pill-val">{formatNodeLabel(node)}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
