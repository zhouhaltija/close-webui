import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { App, ErrorBoundary } from './App';
import './styles.css';
async function start() {
  if (import.meta.env.VITE_ENABLE_MOCK !== 'false') { const { startMock } = await import('./mocks/browser'); await startMock(); }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity }, mutations: { retry: false } } });
  createRoot(document.getElementById('root')!).render(<ErrorBoundary><QueryClientProvider client={client}><BrowserRouter><Routes><Route path="/" element={<App />} /><Route path="/chat/:conversationId" element={<App />} /><Route path="*" element={<div className="recovery"><h1>页面不存在</h1><a href="/">返回首页</a></div>} /></Routes></BrowserRouter></QueryClientProvider></ErrorBoundary>);
}
void start().catch(() => { createRoot(document.getElementById('root')!).render(<div className="recovery"><h1>应用启动失败</h1><p>请刷新页面重试，或检查本地开发配置。</p><button onClick={() => location.reload()}>刷新页面</button></div>); });
