import React from 'react';
import ReactDOMClient from 'react-dom/client';
import App from './App';
import axios from 'axios';

// Set Axios base URL for production API calls
axios.defaults.baseURL = import.meta.env.VITE_API_BASE_URL || '';

ReactDOMClient.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
