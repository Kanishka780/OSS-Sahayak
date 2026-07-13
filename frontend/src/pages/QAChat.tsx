import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { AskResponse, EvidenceLink } from 'shared';
import { EvidenceChain } from '../components/evidence-chain/EvidenceChain';
import { GraphTraversal } from '../components/graph-traversal/GraphTraversal';
import { Send, Mic, MicOff, Volume2, VolumeX, AlertTriangle, ArrowRight, BookOpen } from 'lucide-react';
import { Link } from 'react-router-dom';

interface Message {
  id: string;
  sender: 'user' | 'system';
  text: string;
  evidenceChain?: EvidenceLink[] | null;
  refusal?: boolean;
  audioUrl?: string;
}

export const QAChat: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [repoId, setRepoId] = useState('');
  const [issueNumber, setIssueNumber] = useState(42);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Settings
  const [outputLang, setOutputLang] = useState<'en' | 'hi-en'>('en');
  const [voiceInput, setVoiceInput] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  
  // MediaRecorder for STT
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  // Graph visualization state
  const [graphNodes, setGraphNodes] = useState<any[]>([]);
  const [graphEdges, setGraphEdges] = useState<any[]>([]);
  const [highlightedPath, setHighlightedPath] = useState<string[]>([]);

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

    const fileParam = searchParams.get('file');
    if (fileParam) {
      setQuestion(`What details do we have about file ${fileParam}?`);
    }

    // Set initial structure in graph
    setGraphNodes([]);
    setGraphEdges([]);
  }, [searchParams]);

  // Start recording audio
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64Audio = (reader.result as string).split(',')[1];
          handleSendAudio(base64Audio);
        };
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
      alert('Could not access microphone');
      setVoiceInput(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      // Stop all tracks to release mic
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
    }
  };

  const handleSendAudio = async (base64Audio: string) => {
    setLoading(true);
    setError(null);
    try {
      // Add voice placeholder to chat
      const userMsgId = String(Date.now());
      setMessages(prev => [...prev, { id: userMsgId, sender: 'user', text: '[Voice Input Sent]' }]);

      const response = await axios.post('/api/ask', {
        repo_id: repoId,
        issue_number: issueNumber,
        question: base64Audio,
        input_mode: 'voice',
        output_language: outputLang,
      });

      const data: AskResponse = response.data;
      handleServerResponse(data);
    } catch (err: any) {
      console.error(err);
      setError(err.response?.data?.error?.message || 'Processing voice query failed');
      setLoading(false);
    }
  };

  const [error, setError] = useState<string | null>(null);

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;

    const queryText = question;
    setQuestion('');
    setLoading(true);
    setError(null);

    // Add user message
    const userMsgId = String(Date.now());
    setMessages(prev => [...prev, { id: userMsgId, sender: 'user', text: queryText }]);

    try {
      const response = await axios.post('/api/ask', {
        repo_id: repoId,
        issue_number: issueNumber,
        question: queryText,
        input_mode: 'text',
        output_language: outputLang,
      });

      const data: AskResponse = response.data;
      handleServerResponse(data);
    } catch (err: any) {
      console.error(err);
      setError(err.response?.data?.error?.message || 'Q&A request failed');
      setLoading(false);
    }
  };

  const handleServerResponse = (data: AskResponse) => {
    const sysMsgId = String(Date.now() + 1);

    if (data.refusal) {
      setMessages(prev => [...prev, {
        id: sysMsgId,
        sender: 'system',
        text: 'Can\'t answer this with evidence',
        refusal: true
      }]);
      setGraphNodes([]);
      setGraphEdges([]);
      setHighlightedPath([]);
      setLoading(false);
      return;
    }

    setMessages(prev => [...prev, {
      id: sysMsgId,
      sender: 'system',
      text: data.answer || 'No answer generated.',
      evidenceChain: data.evidence_chain,
      audioUrl: data.audio_url
    }]);

    // Update graph highlights if evidence chain contains files/functions
    if (data.evidence_chain) {
      const paths = data.evidence_chain
        .filter(c => c.type === 'File' || c.type === 'Function')
        .map(c => String(c.id));
      
      // Inject nodes into active graph view if they aren't there
      const newNodes = [...graphNodes];
      data.evidence_chain.forEach(c => {
        if ((c.type === 'File' || c.type === 'Function') && !newNodes.some(n => n.id === String(c.id))) {
          newNodes.push({
            id: String(c.id),
            type: c.type,
            name: String(c.id).split('::').pop() || String(c.id),
          });
        }
      });
      setGraphNodes(newNodes);

      // Build edges between consecutive nodes in the evidence chain
      const newEdges = [...graphEdges];
      const evidenceSteps = data.evidence_chain.filter(c => c.type === 'File' || c.type === 'Function');
      for (let i = 0; i < evidenceSteps.length - 1; i++) {
        const fromId = String(evidenceSteps[i].id);
        const toId = String(evidenceSteps[i + 1].id);
        if (!newEdges.some(e => e.from === fromId && e.to === toId)) {
          newEdges.push({ from: fromId, to: toId });
        }
      }
      setGraphEdges(newEdges);
      setHighlightedPath(paths);
    }

    setLoading(false);
  };

  if (!repoId) {
    return (
      <div style={{ maxWidth: '600px', margin: 'var(--space-64) auto', padding: '0 var(--space-16)', textAlign: 'center' }}>
        <div className="card" style={{ borderColor: 'var(--color-accent-evidence)', padding: 'var(--space-32)' }}>
          <AlertTriangle size={48} style={{ color: 'var(--color-accent-evidence)', marginBottom: 'var(--space-16)' }} />
          <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-8)' }}>No Repository Registered</h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)', marginBottom: 'var(--space-24)' }}>
            Please onboard a repository first to build its evidence graph and use Q&A Chat.
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
    <div style={{ maxWidth: '1200px', margin: 'var(--space-32) auto', padding: '0 var(--space-16)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-24)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-h1)' }}>Codebase Q&A Chat</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)' }}>
            Ask natural language questions. Every answer is strictly grounded in graph evidence.
          </p>
        </div>
        
        {/* Readiness Report link */}
        <Link 
          to={`/readiness-report?issue=${issueNumber}`}
          style={{
            backgroundColor: 'var(--color-accent-evidence)',
            color: 'var(--color-bg-base)',
            padding: 'var(--space-8) var(--space-16)',
            borderRadius: 'var(--radius-card)',
            fontWeight: 'var(--weight-semibold)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)'
          }}
        >
          <span>Contribution Readiness Report</span>
          <ArrowRight size={14} />
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-24)' }}>
        {/* Left Side: Chat interface */}
        <div className="card flex flex-col justify-between" style={{ minHeight: '500px', maxHeight: '600px' }}>
          {/* Chat Settings Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: 'var(--space-12)' }}>
            {/* Lang selection */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
              <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>Output Language:</span>
              <button
                onClick={() => setOutputLang('en')}
                style={{
                  backgroundColor: outputLang === 'en' ? 'var(--color-accent-graph)' : 'transparent',
                  color: outputLang === 'en' ? 'var(--color-bg-base)' : 'var(--color-text-primary)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 'var(--radius-pill)',
                  padding: '2px var(--space-8)',
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                English
              </button>
              <button
                onClick={() => setOutputLang('hi-en')}
                style={{
                  backgroundColor: outputLang === 'hi-en' ? 'var(--color-accent-evidence)' : 'transparent',
                  color: outputLang === 'hi-en' ? 'var(--color-bg-base)' : 'var(--color-text-primary)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 'var(--radius-pill)',
                  padding: '2px var(--space-8)',
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                Hinglish (Sarvam AI)
              </button>
            </div>

            {/* Input mode selection */}
            <button
              onClick={() => setVoiceInput(!voiceInput)}
              style={{
                backgroundColor: 'transparent',
                color: voiceInput ? 'var(--color-accent-evidence)' : 'var(--color-text-secondary)',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-4)',
                fontSize: 'var(--text-caption)'
              }}
            >
              {voiceInput ? <Mic size={14} /> : <MicOff size={14} />}
              <span>{voiceInput ? 'Voice Input' : 'Text Input'}</span>
            </button>
          </div>

          {/* Messages area */}
          <div style={{ flexGrow: 1, overflowY: 'auto', padding: 'var(--space-12) 0', display: 'flex', flexDirection: 'column', gap: 'var(--space-16)' }}>
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--color-text-secondary)', opacity: 0.5, marginTop: 'var(--space-48)' }}>
                <BookOpen size={36} style={{ marginBottom: 'var(--space-8)' }} />
                <div>Ask a question about code dependencies, functions, or git history.</div>
              </div>
            )}

            {messages.map(msg => (
              <div 
                key={msg.id}
                style={{
                  alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  backgroundColor: msg.sender === 'user' ? 'rgba(79, 184, 168, 0.1)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${msg.sender === 'user' ? 'rgba(79, 184, 168, 0.2)' : 'rgba(255,255,255,0.05)'}`,
                  borderRadius: 'var(--radius-card)',
                  padding: 'var(--space-12)',
                }}
              >
                {/* Refusal Template */}
                {msg.refusal ? (
                  <div style={{ borderLeft: '3px solid var(--color-danger)', paddingLeft: 'var(--space-8)' }}>
                    <div className="mono" style={{ color: 'var(--color-danger)', fontWeight: 'var(--weight-semibold)', marginBottom: 'var(--space-4)' }}>
                      Can't answer this with evidence
                    </div>
                    <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>
                      No complete citation chain (Issue → PR → Commit → File → Function) exists for this question in the current graph. Try rephrasing, or ask about a more specific file or function.
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ whiteSpace: 'pre-line', fontSize: 'var(--text-body)' }}>{msg.text}</div>
                    
                    {/* Evidence Chain Component */}
                    {msg.evidenceChain && (
                      <div style={{ marginTop: 'var(--space-12)', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: 'var(--space-8)' }}>
                        <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)' }}>Evidence Chain Citation:</div>
                        <EvidenceChain chain={msg.evidenceChain} animate={false} />
                      </div>
                    )}

                    {/* Audio synthesis player if available */}
                    {msg.audioUrl && (
                      <div style={{ marginTop: 'var(--space-8)', display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                        <audio src={msg.audioUrl} controls style={{ height: '30px', maxWidth: '200px' }} />
                        <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>Speech Output</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}

            {loading && (
              <div className="mono animate-pulse" style={{ alignSelf: 'flex-start', color: 'var(--color-text-secondary)', fontSize: 'var(--text-caption)' }}>
                Reasoning over code graph...
              </div>
            )}
            
            {error && (
              <div className="card" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)', fontSize: 'var(--text-caption)' }}>
                {error}
              </div>
            )}
          </div>

          {/* Input control form */}
          <form onSubmit={handleSendText} style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 'var(--space-12)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-12)' }}>
              {voiceInput ? (
                <button
                  type="button"
                  onMouseDown={startRecording}
                  onMouseUp={stopRecording}
                  onTouchStart={startRecording}
                  onTouchEnd={stopRecording}
                  style={{
                    backgroundColor: isRecording ? 'var(--color-danger)' : 'var(--color-accent-evidence)',
                    color: 'var(--color-bg-base)',
                    border: 'none',
                    borderRadius: 'var(--radius-card)',
                    padding: 'var(--space-12)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexGrow: 1,
                    gap: 'var(--space-8)',
                    fontWeight: 'var(--weight-semibold)',
                    animation: isRecording ? 'pulse 1.5s infinite' : 'none'
                  }}
                >
                  <Mic size={18} />
                  <span>{isRecording ? 'Release to Send Audio' : 'Hold to Speak (Saaras STT)'}</span>
                </button>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="Ask about authentication validator, file imports, etc..."
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    disabled={loading}
                    style={{
                      flexGrow: 1,
                      backgroundColor: 'var(--color-bg-base)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: 'var(--radius-card)',
                      padding: 'var(--space-12)',
                      color: 'var(--color-text-primary)',
                      outline: 'none'
                    }}
                  />
                  <button
                    type="submit"
                    disabled={loading || !question.trim()}
                    style={{
                      backgroundColor: 'var(--color-accent-graph)',
                      color: 'var(--color-bg-base)',
                      border: 'none',
                      borderRadius: 'var(--radius-card)',
                      padding: 'var(--space-12)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: loading || !question.trim() ? 0.6 : 1
                    }}
                  >
                    <Send size={18} />
                  </button>
                </>
              )}
            </div>
          </form>
        </div>

        {/* Right Side: Graph Traversal Live Map */}
        <div style={{ height: '100%' }}>
          <GraphTraversal 
            nodes={graphNodes} 
            edges={graphEdges} 
            highlightedPath={highlightedPath} 
          />
        </div>
      </div>
    </div>
  );
};
