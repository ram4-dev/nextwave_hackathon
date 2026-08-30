import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CDPReactProvider } from '@coinbase/cdp-react';
import { App } from './App';
import { cdpProviderConfig } from './cdpConfig';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CDPReactProvider config={cdpProviderConfig(import.meta.env.VITE_CDP_PROJECT_ID)}>
      <App />
    </CDPReactProvider>
  </StrictMode>,
);
