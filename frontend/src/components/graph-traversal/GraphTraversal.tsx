import React, { useEffect, useState, useMemo } from 'react';
import './GraphTraversal.css';

interface GraphNode {
  id: string;
  type: 'File' | 'Function';
  name: string;
}

interface GraphEdge {
  from: string;
  to: string;
}

interface GraphTraversalProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  highlightedPath?: string[]; // IDs of nodes in path order
}

export const GraphTraversal: React.FC<GraphTraversalProps> = ({
  nodes,
  edges,
  highlightedPath = [],
}) => {
  const [activeStep, setActiveStep] = useState<number>(-1);
  const isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (highlightedPath.length === 0) {
      setActiveStep(-1);
      return;
    }

    if (isReducedMotion) {
      setActiveStep(highlightedPath.length - 1);
      return;
    }

    setActiveStep(0);
    const interval = setInterval(() => {
      setActiveStep(prev => {
        if (prev >= highlightedPath.length - 1) {
          clearInterval(interval);
          return prev;
        }
        return prev + 1;
      });
    }, 600); // Highlight next node every 600ms

    return () => clearInterval(interval);
  }, [highlightedPath, isReducedMotion]);

  // Layout parameters
  const width = 600;
  const height = 400;
  const radius = 120; // Radius of circular layout

  // Map node ID to 2D coordinates arranged in a circle
  const nodePositions = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    nodes.forEach((node, index) => {
      const angle = (index / nodes.length) * 2 * Math.PI - Math.PI / 2;
      pos[node.id] = {
        x: width / 2 + radius * Math.cos(angle),
        y: height / 2 + radius * Math.sin(angle),
      };
    });
    return pos;
  }, [nodes]);

  // Determine if a node is in the active traversal path
  const getNodeStatus = (nodeId: string) => {
    const pathIndex = highlightedPath.indexOf(nodeId);
    if (pathIndex === -1) return 'inactive';
    if (pathIndex <= activeStep) return 'active';
    return 'pending';
  };

  // Determine if an edge is highlighted
  const isEdgeHighlighted = (from: string, to: string) => {
    if (highlightedPath.length < 2) return false;
    for (let i = 0; i < activeStep; i++) {
      if (highlightedPath[i] === from && highlightedPath[i + 1] === to) {
        return true;
      }
    }
    return false;
  };

  return (
    <div className="graph-container card">
      <div className="graph-header flex items-center justify-between">
        <h3 className="graph-title">Graph Traversal Live Map</h3>
        <div className="graph-legend flex items-center gap-16">
          <div className="legend-item">
            <span className="legend-dot dot-file"></span> File
          </div>
          <div className="legend-item">
            <span className="legend-dot dot-func"></span> Function
          </div>
          <div className="legend-item">
            <span className="legend-dot dot-active"></span> Explored Path
          </div>
        </div>
      </div>

      <div className="graph-canvas-wrapper">
        {nodes.length === 0 ? (
          <div className="graph-empty mono">No Graph Context Loaded</div>
        ) : (
          <svg className="graph-canvas" viewBox={`0 0 ${width} ${height}`}>
            {/* Draw Edges */}
            {edges.map((edge, index) => {
              const start = nodePositions[edge.from];
              const end = nodePositions[edge.to];
              if (!start || !end) return null;

              const isHighlighted = isEdgeHighlighted(edge.from, edge.to);

              return (
                <g key={`edge-${index}`}>
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    className={`graph-link ${isHighlighted ? 'link-highlighted' : ''}`}
                  />
                  {/* Arrow marker */}
                  <polygon
                    points={`${end.x},${end.y} ${end.x - 6},${end.y - 3} ${end.x - 6},${end.y + 3}`}
                    transform={`rotate(${(Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI}, ${end.x}, ${end.y})`}
                    className={`graph-arrow ${isHighlighted ? 'arrow-highlighted' : ''}`}
                  />
                </g>
              );
            })}

            {/* Draw Nodes */}
            {nodes.map(node => {
              const pos = nodePositions[node.id];
              if (!pos) return null;

              const status = getNodeStatus(node.id);
              const nodeClass = `graph-node node-${node.type.toLowerCase()} node-${status}`;

              return (
                <g key={node.id} className="node-group" transform={`translate(${pos.x}, ${pos.y})`}>
                  <circle
                    r={node.type === 'File' ? 14 : 10}
                    className={nodeClass}
                  />
                  <text
                    y={node.type === 'File' ? 30 : 24}
                    textAnchor="middle"
                    className={`node-label mono ${status === 'active' ? 'label-active' : ''}`}
                  >
                    {node.name.split('/').pop()}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
};
