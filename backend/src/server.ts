import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import express from 'express';
import cors from 'cors';
import reposRouter from './routes/repos';
import askRouter from './routes/ask';
import learningPathRouter from './routes/learningPath';
import readinessReportRouter from './routes/readinessReport';
import reviewerRecommendationRouter from './routes/reviewerRecommendation';

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Support base64 audio uploads

// API Routes
app.use('/api/repos', reposRouter);
app.use('/api/ask', askRouter);
app.use('/api/learning-path', learningPathRouter);
app.use('/api/reports/readiness', readinessReportRouter);
app.use('/api/reviewer-recommendation', reviewerRecommendationRouter);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    error: {
      code: 'server_error',
      message: err.message || 'An unexpected error occurred'
    }
  });
});

app.listen(port, () => {
  console.log(`OSS Sahayak backend server running on http://localhost:${port}`);
});
