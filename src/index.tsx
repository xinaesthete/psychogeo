import { createRoot } from 'react-dom/client';
import './vite/buffer-shim';
import './index.css';
import './geo/TileShader';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
