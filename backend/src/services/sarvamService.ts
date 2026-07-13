import axios from 'axios';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config();

export class SarvamService {
  private apiKey: string | undefined;
  private apiBase = 'https://api.sarvam.ai';

  constructor() {
    this.apiKey = process.env.SARVAM_API_KEY;
    if (!this.apiKey) {
      console.warn('SARVAM_API_KEY is not set. SarvamService will run in degraded (bypass) mode.');
    }
  }

  private get headers() {
    return {
      'API-Subscription-Key': this.apiKey || '',
      'Content-Type': 'application/json',
    };
  }

  // Transcribe audio using Saaras STT
  async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Sarvam API key not set');
    }

    try {
      // Create FormData payload
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
      form.append('model', 'saaras:v1');

      const response = await axios.post(`${this.apiBase}/speech-to-text`, form, {
        headers: {
          ...form.getHeaders(),
          'API-Subscription-Key': this.apiKey,
        },
      });

      return response.data.transcript || '';
    } catch (err: any) {
      console.error('Sarvam STT failed:', err.message);
      throw err;
    }
  }

  // Rephrase English to Hinglish via Sarvam LLM
  async rephraseToHinglish(text: string): Promise<string> {
    if (!this.apiKey) {
      console.log('Sarvam bypass: returning original text (no API key)');
      return text;
    }

    try {
      const response = await axios.post(
        `${this.apiBase}/v1/chat/completions`,
        {
          model: 'sarvam-30b',
          messages: [
            {
              role: 'user',
              content: `Rephrase the following technical explanation into Hinglish (conversational Hindi written in Latin/English script, incorporating standard English technical terms). Maintain all code variables, file paths, and citations unchanged:\n\n${text}`,
            },
          ],
        },
        { headers: this.headers }
      );

      return response.data.choices?.[0]?.message?.content || text;
    } catch (err: any) {
      console.error('Sarvam translation/rephrasing failed, returning original text:', err.message);
      return text;
    }
  }

  // Synthesize Speech using Bulbul TTS
  // Returns base64 encoded audio
  async synthesizeSpeech(text: string, language: 'en-IN' | 'hi-IN' = 'hi-IN'): Promise<string | null> {
    if (!this.apiKey) {
      return null;
    }

    try {
      const response = await axios.post(
        `${this.apiBase}/text-to-speech`,
        {
          inputs: [text],
          target_language_code: language,
          speaker: 'meera', // default voice
          speech_rate: 1.0,
        },
        { headers: this.headers }
      );

      // Returns the base64 string from audio_contents
      return response.data.audio_contents || null;
    } catch (err: any) {
      console.error('Sarvam TTS failed:', err.message);
      return null;
    }
  }
}
