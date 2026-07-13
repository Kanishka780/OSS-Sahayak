import { Router, Request, Response } from 'express';
import { GeminiService } from '../services/geminiService';
import { SarvamService } from '../services/sarvamService';

const router = Router();
const gemini = new GeminiService();
const sarvam = new SarvamService();

// POST /api/ask
router.post('/', async (req: Request, res: Response) => {
  const { repo_id, issue_number, question, input_mode, output_language } = req.body;

  if (!repo_id || !issue_number || !question) {
    return res.status(400).json({
      error: { code: 'invalid_request', message: 'repo_id, issue_number, and question are required' }
    });
  }

  try {
    let queryText = question;

    // 1. Voice transcription if request is voice
    if (input_mode === 'voice') {
      try {
        const audioBuffer = Buffer.from(question, 'base64');
        queryText = await sarvam.transcribeAudio(audioBuffer);
        console.log(`Transcribed voice query: "${queryText}"`);
      } catch (err: any) {
        console.error('Transcription failed, falling back to text if query looks like text:', err);
        // If it was already text, continue; otherwise fail
        if (question.length > 500) {
          return res.status(422).json({
            error: { code: 'stt_failed', message: 'Failed to transcribe audio input' }
          });
        }
      }
    }

    // 2. Query graph & Gemini reasoning
    const result = await gemini.askQuestion(repo_id, Number(issue_number), queryText);

    if (result.refusal) {
      return res.status(200).json({
        answer: null,
        evidence_chain: null,
        refusal: true,
        reason: result.reason || 'no_complete_citation_chain'
      });
    }

    let finalAnswer = result.answer || '';

    // 3. Translate/rephrase if Hinglish requested
    if (output_language === 'hi-en') {
      finalAnswer = await sarvam.rephraseToHinglish(finalAnswer);
    }

    // 4. Synthesize speech if voice requested
    let audioUrl: string | undefined;
    if (input_mode === 'voice') {
      const audioBase64 = await sarvam.synthesizeSpeech(
        finalAnswer,
        output_language === 'hi-en' ? 'hi-IN' : 'en-IN'
      );
      if (audioBase64) {
        audioUrl = `data:audio/wav;base64,${audioBase64}`;
      }
    }

    return res.status(200).json({
      answer: finalAnswer,
      evidence_chain: result.evidence_chain,
      refusal: false,
      audio_url: audioUrl
    });
  } catch (error: any) {
    console.error('Ask error:', error);
    if (error.message && error.message.includes('API key')) {
      return res.status(503).json({ error: { code: 'gemini_unavailable', message: 'Gemini reasoning layer is currently offline' } });
    }
    return res.status(500).json({ error: { code: 'server_error', message: error.message } });
  }
});

export default router;
