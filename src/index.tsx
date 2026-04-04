import { createRoot } from 'react-dom/client';
import './vite/buffer-shim';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
