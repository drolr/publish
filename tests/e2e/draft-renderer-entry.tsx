// Test-only mount control exercises React cleanup without exposing product controls.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/renderer/App';
import '../../src/renderer/tokens.css';
const element = document.getElementById('root')!;
let root = createRoot(element);
const mount = () =>
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
Object.assign(window, {
  draftRendererHarness: {
    unmount: () => root.unmount(),
    mount: () => {
      root = createRoot(element);
      mount();
    },
  },
});
mount();
